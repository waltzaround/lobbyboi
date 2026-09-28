// A room connection that survives flaky networks: it reconnects with backoff,
// keeps the player's slot (the server holds it), sequences inputs, tracks RTT
// and the server clock, and decodes delta snapshots.

import {
  CLOSE,
  NO_RECONNECT,
  PROTOCOL_VERSION,
  type ClientMessage,
  type RoomInfo,
  type RoomSettings,
  type ServerMessage,
} from '../protocol.js';
import { DeltaDecoder } from '../shared/delta.js';

export type Status = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Snapshot<State> {
  tick: number;
  /** Server time (ms) when the snapshot was taken. */
  time: number;
  /** Last input sequence the server applied for you. Use it to reconcile prediction. */
  ack: number;
  state: State;
}

export interface ConnectionEvents<State> {
  status: (status: Status, detail?: { code: number; reason: string }) => void;
  welcome: (you: string, room: RoomInfo) => void;
  room: (room: RoomInfo) => void;
  snapshot: (snapshot: Snapshot<State>) => void;
  event: (name: string, data: unknown) => void;
  chat: (message: { from: string; name: string; text: string }) => void;
  error: (error: { code: string; message: string }) => void;
}

export interface ConnectOptions {
  /** Full ws(s):// URL of the room socket. */
  url: string;
  /** Session token, for when cookies aren't available (cross-origin, embeds). */
  token?: string;
  maxRetries?: number;
  /** Heartbeat interval. Must be well under the server's idleMs. */
  heartbeatMs?: number;
  /** RTT ping interval. */
  pingMs?: number;
  /** Pass a WebSocket implementation outside the browser (e.g. `ws` in Node). */
  WebSocket?: typeof WebSocket;
}

type Listener = (...args: never[]) => void;

export class RoomConnection<State = Record<string, unknown>, Input = unknown> {
  status: Status = 'connecting';
  you: string | null = null;
  room: RoomInfo | null = null;
  /** Smoothed round-trip time in ms. */
  rtt = 0;
  tickHz = 30;
  snapshotHz = 15;

  private ws: WebSocket | null = null;
  private listeners = new Map<keyof ConnectionEvents<State>, Set<Listener>>();
  private decoder = new DeltaDecoder();
  private seq = 0;
  private attempts = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pings = new Map<number, number>();
  private pingId = 0;
  private clockOffset: number | null = null;
  private lastResync = 0;
  private closedByUser = false;

  constructor(private options: ConnectOptions) {
    this.open();
  }

  on<K extends keyof ConnectionEvents<State>>(event: K, listener: ConnectionEvents<State>[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => set!.delete(listener as Listener);
  }

  /** Estimated server time now, in ms. Use it to interpolate snapshots. */
  serverTime(): number {
    return Date.now() - (this.clockOffset ?? 0);
  }

  /** Send input. Returns its sequence number for client-side prediction. */
  sendInput(input: Input): number {
    this.seq += 1;
    this.send({ t: 'input', seq: this.seq, input });
    return this.seq;
  }

  ready(ready = true) {
    this.send({ t: 'ready', ready });
  }
  start() {
    this.send({ t: 'start' });
  }
  settings(settings: Partial<RoomSettings>) {
    this.send({ t: 'settings', settings });
  }
  kick(playerId: string) {
    this.send({ t: 'kick', playerId });
  }
  chat(text: string) {
    this.send({ t: 'chat', text });
  }
  setMeta(meta: Record<string, unknown>) {
    this.send({ t: 'meta', meta });
  }

  get isHost() {
    return !!this.you && this.room?.hostId === this.you;
  }

  /** Leave the room for good and give up the slot. */
  leave() {
    this.send({ t: 'leave' });
    this.close();
  }

  /** Close the socket. The server holds the slot for a while in case you come back. */
  close() {
    this.closedByUser = true;
    this.cleanup();
    this.ws?.close(CLOSE.NORMAL);
    this.setStatus('closed');
  }

  private open() {
    const url = new URL(this.options.url);
    url.searchParams.set('v', String(PROTOCOL_VERSION));
    if (this.options.token) url.searchParams.set('session', this.options.token);
    const Socket = this.options.WebSocket ?? WebSocket;
    const ws = new Socket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.decoder.reset();
      this.cleanup();
      this.timers.push(setInterval(() => ws.readyState === 1 && ws.send('{"t":"hb"}'), this.options.heartbeatMs ?? 10_000));
      this.timers.push(setInterval(() => this.ping(), this.options.pingMs ?? 2000));
      this.ping();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string' && event.data !== '{"t":"hb"}') this.receive(JSON.parse(event.data));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.cleanup();
      if (this.closedByUser) return;
      const detail = { code: event.code, reason: event.reason };
      const maxRetries = this.options.maxRetries ?? 12;
      if (NO_RECONNECT.has(event.code) || this.attempts >= maxRetries) {
        this.setStatus('closed', detail);
        return;
      }
      this.setStatus('reconnecting', detail);
      const delay = Math.min(5000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
      this.retry = setTimeout(() => this.open(), delay);
    };
  }

  private receive(message: ServerMessage) {
    switch (message.t) {
      case 'welcome':
        this.you = message.you;
        this.room = message.room;
        this.tickHz = message.tickHz;
        this.snapshotHz = message.snapshotHz;
        this.seq = Math.max(this.seq, message.seq);
        this.observeClock(message.time, 0);
        this.setStatus('open');
        this.emit('welcome', message.you, message.room);
        this.emit('room', message.room);
        return;
      case 'room':
        this.room = message.room;
        return this.emit('room', message.room);
      case 'snap': {
        const state = this.decoder.full(message.frame, message.state as Record<string, unknown>) as State;
        return this.emit('snapshot', { tick: message.tick, time: message.time, ack: message.ack, state });
      }
      case 'delta': {
        const state = this.decoder.apply(message.frame, message.base, message.patch);
        if (!state) {
          // Lost our baseline. Ask for a keyframe, at most once a second.
          if (Date.now() - this.lastResync > 1000) {
            this.lastResync = Date.now();
            this.send({ t: 'resync' });
          }
          return;
        }
        return this.emit('snapshot', { tick: message.tick, time: message.time, ack: message.ack, state: state as State });
      }
      case 'pong': {
        const sent = this.pings.get(message.id);
        if (sent === undefined) return;
        this.pings.delete(message.id);
        const rtt = Date.now() - sent;
        this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.2 : rtt;
        return this.observeClock(message.time, rtt);
      }
      case 'event':
        return this.emit('event', message.name, message.data);
      case 'chat':
        return this.emit('chat', { from: message.from, name: message.name, text: message.text });
      case 'error':
        return this.emit('error', { code: message.code, message: message.message });
    }
  }

  /**
   * Offset = local - server, from the sample with the least delay. It drifts
   * up slowly so a lasting latency increase is absorbed without a jump.
   * From fieldshooter2's smooth.js.
   */
  private observeClock(serverTime: number, rtt: number) {
    const sample = Date.now() - rtt / 2 - serverTime;
    if (this.clockOffset === null || sample < this.clockOffset) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.01;
  }

  private ping() {
    const id = ++this.pingId;
    this.pings.set(id, Date.now());
    if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value!);
    this.send({ t: 'ping', id });
  }

  private send(message: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  private setStatus(status: Status, detail?: { code: number; reason: string }) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status, detail);
  }

  private emit<K extends keyof ConnectionEvents<State>>(event: K, ...args: Parameters<ConnectionEvents<State>[K]>) {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
  }

  private cleanup() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}
