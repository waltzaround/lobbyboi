// GameRoom: a Durable Object base class that runs one room from lobby to
// results. Extend it, implement createGame/step/view, and you have a lobby with
// ready-up, host controls, bots, reconnects and an authoritative tick loop.
//
// Lifecycle
//   lobby ──start──▶ countdown ──alarm──▶ playing ──step() returns──▶ results ──alarm──▶ lobby
//
// Timekeeping
//   Lobby, countdown and results are driven by alarms, and heartbeats are
//   answered by the runtime's auto-response, so an idle lobby hibernates and
//   costs nothing. While `playing`, a setInterval runs a fixed-step loop with an
//   accumulator. That keeps the object awake, which is fine: a match in
//   progress is receiving input every frame anyway.
//
// Identity
//   Rooms trust only the X-Lobbyboi-Player header, which the Worker sets from a
//   verified session. One live socket per player; a newer socket replaces an
//   older one (close 4001), which is how tab refreshes and reconnects work.

import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Phase,
  type PlayerInfo,
  type RoomInfo,
  type RoomSettings,
  type ServerMessage,
} from '../protocol.js';
import { DeltaEncoder } from '../shared/delta.js';
import { RENEW_MS, type LobbyDirectory } from './directory.js';
import { RateLimiter, Serial, error } from './util.js';

export const PLAYER_HEADER = 'X-Lobbyboi-Player';
export const HEARTBEAT = '{"t":"hb"}';
export const HEARTBEAT_REPLY = '{"t":"hb"}';

export interface RoomConfig {
  /** Hard cap on humans plus bots. */
  maxPlayers: number;
  /** Humans plus bots needed to start. */
  minPlayers: number;
  /** Simulation steps per second while playing. */
  tickHz: number;
  /** Snapshots per second. Must divide tickHz. */
  snapshotHz: number;
  countdownMs: number;
  resultsMs: number;
  /** How long a dropped player's slot is held in the lobby. */
  lobbyReconnectMs: number;
  /** How long a dropped player's slot is held during a match. */
  reconnectMs: number;
  /** How long a quick-match reservation is held before the player connects. */
  reservationMs: number;
  /** How long a room with nobody in it survives before it is deleted. */
  emptyMs: number;
  /** Let new players join a match in progress (via onJoin). */
  joinInProgress: boolean;
  /** Start the countdown as soon as everyone is ready, instead of waiting for the host. */
  autoStart: boolean;
  /** Send per-connection deltas instead of full snapshots. */
  delta: boolean;
  keyframeEvery: number;
  maxMessageBytes: number;
  messagesPerSecond: number;
  /** Close sockets that haven't sent anything, including heartbeats, for this long. */
  idleMs: number;
  /** Env binding for the LobbyDirectory. Rooms are unlisted if it's missing. */
  directoryBinding: string;
  /** Names handed to bots, in order. */
  botNames: string[];
  settings: Partial<RoomSettings>;
}

export const DEFAULT_CONFIG: RoomConfig = {
  maxPlayers: 8,
  minPlayers: 1,
  tickHz: 30,
  snapshotHz: 15,
  countdownMs: 3000,
  resultsMs: 8000,
  lobbyReconnectMs: 15_000,
  reconnectMs: 60_000,
  reservationMs: 20_000,
  emptyMs: 60_000,
  joinInProgress: true,
  autoStart: false,
  delta: true,
  keyframeEvery: 60,
  maxMessageBytes: 4096,
  messagesPerSecond: 90,
  idleMs: 45_000,
  directoryBinding: 'LOBBY',
  botNames: ['Botsworth', 'Clanker', 'Rusty', 'Sprocket', 'Widget', 'Gizmo', 'Bolt', 'Servo', 'Pixel', 'Chip'],
  settings: {},
};

interface PlayerRecord extends PlayerInfo {
  joinedAt: number;
  /** Last input sequence number applied, echoed in snapshots as `ack`. */
  seq: number;
  /** Slot is held until this time while the player is disconnected or reserved. */
  heldUntil?: number;
}

interface Meta {
  code: string;
  createdAt: number;
  phase: Phase;
  hostId: string | null;
  players: PlayerRecord[];
  settings: RoomSettings;
  phaseEndsAt: number | null;
  results: unknown;
  listed: boolean;
  /** When the last human left. */
  emptySince?: number;
}

interface Connection {
  playerId: string;
  limiter: RateLimiter;
  encoder?: DeltaEncoder;
}

export interface MatchContext<Input> {
  /** Everyone in the match, including bots. */
  readonly players: readonly PlayerInfo[];
  readonly settings: RoomSettings;
  /** Latest input per player; bots' inputs appear here too. Delete entries to consume one-shot inputs. */
  readonly inputs: Map<string, Input>;
  readonly tick: number;
  /** Seconds per step. */
  readonly dt: number;
  /** Send a one-off event to everyone, or to one player. */
  emit(name: string, data?: unknown, to?: string): void;
}

export interface JoinRequest {
  id: string;
  name: string;
}

type Hydrated<State> = { state: State; tick: number } | null;

export abstract class GameRoom<State, Input = unknown, Env = unknown> extends DurableObject<Env> {
  /** Override in subclasses: `static config = { ...DEFAULT_CONFIG, maxPlayers: 16 }`. */
  static config: Partial<RoomConfig> = {};

  protected readonly config: RoomConfig;
  protected meta: Meta | null = null;
  protected match: Hydrated<State> = null;
  private inputs = new Map<string, Input>();
  private connections = new Map<WebSocket, Connection>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private accumulator = 0;
  private lastStepAt = 0;
  private renewAt = 0;
  private lastListing = '';
  private directoryQueue = new Serial();

  // ---- Game hooks ---------------------------------------------------------

  /** Build the initial match state when the countdown ends. */
  protected abstract createGame(ctx: MatchContext<Input>): State;

  /** Advance one fixed step. Return a results object to end the match. */
  protected abstract step(state: State, ctx: MatchContext<Input>): unknown;

  /** What `playerId` is allowed to see. Return a plain JSON object. */
  protected abstract view(state: State, playerId: string): Record<string, unknown>;

  /** Validate and normalise raw client input. Return null to drop it. */
  protected parseInput(raw: unknown): Input | null {
    return raw && typeof raw === 'object' ? (raw as Input) : null;
  }

  /** Decide a bot's input for this tick. Return null to leave it idle. */
  protected botInput(_state: State, _botId: string, _ctx: MatchContext<Input>): Input | null {
    return null;
  }

  /** A player (human or bot) joined a match in progress. */
  protected onJoin(_state: State, _player: PlayerInfo, _ctx: MatchContext<Input>): void {}

  /** A player (human or bot) left a match in progress for good. */
  protected onLeave(_state: State, _playerId: string, _ctx: MatchContext<Input>): void {}

  /** Clean host-provided custom settings. Throw to reject them. */
  protected parseSettings(custom: Record<string, unknown>): Record<string, unknown> {
    return custom;
  }

  // ---- Setup --------------------------------------------------------------

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = { ...DEFAULT_CONFIG, ...(this.constructor as typeof GameRoom).config };
    if (this.config.tickHz % this.config.snapshotHz !== 0)
      throw new Error('lobbyboi: snapshotHz must divide tickHz');
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT_REPLY));
    this.ctx.blockConcurrencyWhile(async () => {
      this.meta = (await this.ctx.storage.get<Meta>('meta')) ?? null;
      if (!this.meta) return;
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as { playerId?: string } | null;
        if (attachment?.playerId) this.connections.set(ws, this.connection(attachment.playerId));
      }
      // Match state lives in memory. If the object restarted mid-match (a deploy,
      // an eviction) there's nothing to resume, so fall back to the lobby.
      if (this.meta.phase === 'playing') {
        this.meta.phase = 'lobby';
        this.meta.phaseEndsAt = null;
        for (const player of this.meta.players) player.ready = player.bot;
        await this.save();
        this.broadcast({ t: 'event', name: 'match_aborted', data: { reason: 'restart' } });
        this.broadcastRoom();
      }
    });
  }

  private connection(playerId: string): Connection {
    return {
      playerId,
      limiter: new RateLimiter(this.config.messagesPerSecond),
      encoder: this.config.delta ? new DeltaEncoder(this.config.keyframeEvery) : undefined,
    };
  }

  // ---- RPC from the Worker ------------------------------------------------

  /** Claim this room for a new code. Returns false if it is already in use. */
  async init(code: string, settings: Partial<RoomSettings> = {}): Promise<boolean> {
    if (this.meta) return false;
    const base: RoomSettings = {
      name: `Room ${code}`,
      public: true,
      maxPlayers: this.config.maxPlayers,
      bots: 0,
      custom: {},
      ...this.config.settings,
    };
    this.meta = {
      code,
      createdAt: Date.now(),
      phase: 'lobby',
      hostId: null,
      players: [],
      settings: this.cleanSettings({ ...base, ...settings }, base),
      phaseEndsAt: null,
      results: null,
      listed: false,
    };
    await this.save();
    // An empty room nobody joins still has to go away.
    await this.schedule(Date.now() + this.config.emptyMs);
    return true;
  }

  async info(): Promise<RoomInfo | null> {
    return this.meta ? this.roomInfo() : null;
  }

  /**
   * Hold a slot for a player who is about to connect (quick-match). Returns an
   * error code, or null on success.
   */
  async reserve(player: JoinRequest): Promise<string | null> {
    if (!this.meta) return 'not_found';
    const refusal = this.admit(player);
    if (refusal) return refusal;
    const record = this.meta!.players.find((p) => p.id === player.id)!;
    if (!this.isConnected(player.id)) record.heldUntil = Date.now() + this.config.reservationMs;
    await this.commit();
    return null;
  }

  // ---- WebSocket upgrade --------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (!this.meta) return error('not_found', 'No such room', 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return error('upgrade_required', 'Expected a WebSocket upgrade', 426);
    const header = request.headers.get(PLAYER_HEADER);
    if (!header) return error('unauthorized', 'Missing player identity', 401);
    const player = JSON.parse(header) as JoinRequest;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [player.id]);

    const version = Number(new URL(request.url).searchParams.get('v'));
    if (version !== PROTOCOL_VERSION) {
      this.send(server, { t: 'error', code: 'version', message: `Server speaks protocol ${PROTOCOL_VERSION}` });
      server.close(CLOSE.VERSION, 'Protocol version mismatch');
      return new Response(null, { status: 101, webSocket: client });
    }

    const refusal = this.admit(player);
    if (refusal) {
      this.send(server, { t: 'error', code: refusal, message: REFUSALS[refusal] ?? refusal });
      server.close(CLOSE.CLOSED, REFUSALS[refusal] ?? refusal);
      return new Response(null, { status: 101, webSocket: client });
    }

    server.serializeAttachment({ playerId: player.id, at: Date.now() });

    // One socket per player: the newest wins.
    for (const old of this.ctx.getWebSockets(player.id))
      if (old !== server) {
        this.connections.delete(old);
        old.close(CLOSE.REPLACED, 'Connected from somewhere else');
      }
    this.connections.set(server, this.connection(player.id));

    const record = this.meta.players.find((p) => p.id === player.id)!;
    delete record.heldUntil;
    record.name = player.name;
    record.connected = true;
    this.meta.hostId ??= player.id;
    this.send(server, {
      t: 'welcome',
      you: player.id,
      room: this.roomInfo(),
      time: Date.now(),
      tickHz: this.config.tickHz,
      snapshotHz: this.config.snapshotHz,
      // A fresh page load mid-match must continue from the server's sequence.
      seq: record.seq,
    });
    if (this.match) this.sendSnapshot(server, this.connections.get(server)!, this.context());
    await this.commit();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Add or re-admit a player. Returns an error code on refusal. */
  private admit(player: JoinRequest): string | null {
    const meta = this.meta!;
    const known = meta.players.find((p) => p.id === player.id && !p.bot);
    if (known) return null;
    if (meta.phase !== 'lobby' && !this.config.joinInProgress) return 'in_progress';
    const humans = meta.players.filter((p) => !p.bot).length;
    if (humans >= Math.min(meta.settings.maxPlayers, this.config.maxPlayers)) return 'full';
    const record: PlayerRecord = {
      id: player.id,
      name: player.name,
      bot: false,
      ready: false,
      connected: false,
      joinedAt: Date.now(),
      seq: 0,
    };
    meta.players.push(record);
    // Joining cancels a countdown so nobody is dragged into a match unready.
    if (meta.phase === 'countdown') this.cancelCountdown();
    this.syncBots();
    if (this.match && meta.phase === 'playing') this.onJoin(this.match.state, publicPlayer(record), this.context());
    return null;
  }

  // ---- Messages -----------------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const connection = this.connections.get(ws) ?? this.rehydrate(ws);
    if (!connection || !this.meta) return ws.close(CLOSE.CLOSED, 'Room closed');
    if (typeof raw !== 'string' || raw.length > this.config.maxMessageBytes)
      return ws.close(CLOSE.INVALID, 'Message too large');
    if (!connection.limiter.take()) return ws.close(CLOSE.POLICY, 'Too many messages');
    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return ws.close(CLOSE.INVALID, 'Invalid JSON');
    }
    const player = this.meta.players.find((p) => p.id === connection.playerId);
    if (!player) return ws.close(CLOSE.KICKED, 'Not in this room');
    await this.handle(ws, connection, player, message);
  }

  private async handle(ws: WebSocket, connection: Connection, player: PlayerRecord, message: ClientMessage) {
    const meta = this.meta!;
    const isHost = meta.hostId === player.id;
    switch (message?.t) {
      case 'input': {
        if (meta.phase !== 'playing' || !this.match) return;
        if (!Number.isInteger(message.seq) || message.seq <= player.seq) return;
        const input = this.parseInput(message.input);
        if (input === null) return;
        player.seq = message.seq;
        this.inputs.set(player.id, input);
        return;
      }
      case 'ping':
        return this.send(ws, { t: 'pong', id: Number(message.id) || 0, time: Date.now() });
      case 'resync':
        connection.encoder?.reset();
        return;
      case 'ready':
        if (meta.phase !== 'lobby' && meta.phase !== 'countdown') return;
        player.ready = message.ready === true;
        if (!player.ready && meta.phase === 'countdown') this.cancelCountdown();
        if (this.config.autoStart) this.tryStart(null);
        return this.commit();
      case 'start':
        if (!isHost) return this.reject(ws, 'not_host');
        return this.tryStart(ws);
      case 'settings': {
        if (!isHost) return this.reject(ws, 'not_host');
        if (meta.phase !== 'lobby') return this.reject(ws, 'in_progress');
        try {
          meta.settings = this.cleanSettings({ ...meta.settings, ...message.settings }, meta.settings);
        } catch (err) {
          return this.send(ws, { t: 'error', code: 'bad_settings', message: String((err as Error).message ?? err) });
        }
        // Changing the rules un-readies everyone, so nobody agrees to a game they didn't see.
        for (const p of meta.players) p.ready = p.bot;
        this.syncBots();
        return this.commit();
      }
      case 'kick': {
        if (!isHost) return this.reject(ws, 'not_host');
        if (message.playerId === player.id) return;
        for (const socket of this.ctx.getWebSockets(message.playerId)) socket.close(CLOSE.KICKED, 'Kicked by host');
        this.remove(message.playerId);
        return this.commit();
      }
      case 'meta': {
        const size = JSON.stringify(message.meta ?? {}).length;
        if (size > 512 || typeof message.meta !== 'object') return this.reject(ws, 'bad_meta');
        player.meta = message.meta;
        return this.commit();
      }
      case 'chat': {
        const text = String(message.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (text) this.broadcast({ t: 'chat', from: player.id, name: player.name, text });
        return;
      }
      case 'leave': {
        this.connections.delete(ws);
        ws.close(CLOSE.NORMAL, 'Left');
        this.remove(player.id);
        return this.commit();
      }
      default:
        return this.reject(ws, 'unknown_message');
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
  }

  private async dropped(ws: WebSocket) {
    const connection = this.connections.get(ws) ?? this.rehydrate(ws);
    this.connections.delete(ws);
    if (!connection || !this.meta) return;
    if (this.isConnected(connection.playerId)) return; // replaced by a newer socket
    const player = this.meta.players.find((p) => p.id === connection.playerId);
    if (!player) return;
    player.connected = false;
    const hold = this.meta.phase === 'lobby' ? this.config.lobbyReconnectMs : this.config.reconnectMs;
    player.heldUntil = Date.now() + hold;
    if (this.meta.phase === 'countdown') this.cancelCountdown();
    if (this.meta.hostId === player.id) this.migrateHost();
    await this.commit();
  }

  // ---- Phases -------------------------------------------------------------

  private tryStart(ws: WebSocket | null) {
    const meta = this.meta!;
    if (meta.phase !== 'lobby') return ws && this.reject(ws, 'in_progress');
    const connected = meta.players.filter((p) => !p.bot && p.connected);
    if (meta.players.length < this.config.minPlayers || connected.length === 0)
      return ws && this.reject(ws, 'not_enough_players');
    // The host starting counts as the host being ready.
    const waiting = connected.filter((p) => !p.ready && !(ws && p.id === meta.hostId));
    if (waiting.length) return ws && this.reject(ws, 'not_ready');
    meta.phase = 'countdown';
    meta.phaseEndsAt = Date.now() + this.config.countdownMs;
    return this.commit();
  }

  private cancelCountdown() {
    this.meta!.phase = 'lobby';
    this.meta!.phaseEndsAt = null;
  }

  private beginMatch() {
    const meta = this.meta!;
    meta.phase = 'playing';
    meta.phaseEndsAt = null;
    meta.results = null;
    this.inputs.clear();
    for (const player of meta.players) player.seq = 0;
    const ctx = this.context(0);
    this.match = { state: this.createGame(ctx), tick: 0 };
    for (const connection of this.connections.values()) connection.encoder?.reset();
    this.accumulator = 0;
    this.lastStepAt = Date.now();
    this.loop ??= setInterval(() => this.run(), 1000 / this.config.tickHz);
  }

  private endMatch(results: unknown) {
    const meta = this.meta!;
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.match = null;
    this.inputs.clear();
    meta.phase = 'results';
    meta.results = results ?? null;
    meta.phaseEndsAt = Date.now() + this.config.resultsMs;
    for (const player of meta.players) player.ready = player.bot;
  }

  /** Fixed-step loop with an accumulator. At most 5 catch-up steps per wake. */
  private run() {
    const meta = this.meta;
    if (!meta || !this.match || meta.phase !== 'playing') return;
    if (!meta.players.some((p) => !p.bot && p.connected)) {
      // Everyone left. Nobody to show results to, so go straight back to the lobby.
      this.endMatch(null);
      meta.phase = 'lobby';
      meta.phaseEndsAt = null;
      void this.commit();
      return;
    }
    const now = Date.now();
    const stepMs = 1000 / this.config.tickHz;
    this.accumulator = Math.min(this.accumulator + (now - this.lastStepAt), stepMs * 5);
    this.lastStepAt = now;
    const every = this.config.tickHz / this.config.snapshotHz;
    while (this.accumulator >= stepMs) {
      this.accumulator -= stepMs;
      const match = this.match;
      match.tick++;
      const ctx = this.context();
      for (const bot of meta.players)
        if (bot.bot) {
          const input = this.botInput(match.state, bot.id, ctx);
          if (input !== null) this.inputs.set(bot.id, input);
        }
      const results = this.step(match.state, ctx);
      if (results !== undefined && results !== null) {
        this.snapshotAll(ctx);
        this.endMatch(results);
        void this.commit();
        return;
      }
      if (match.tick % every === 0) this.snapshotAll(ctx);
    }
  }

  // ---- Snapshots ----------------------------------------------------------

  private snapshotAll(ctx: MatchContext<Input>) {
    for (const [ws, connection] of this.connections) this.sendSnapshot(ws, connection, ctx);
  }

  private sendSnapshot(ws: WebSocket, connection: Connection, ctx: MatchContext<Input>) {
    if (!this.match) return;
    const player = this.meta!.players.find((p) => p.id === connection.playerId);
    const header = { tick: ctx.tick, time: Date.now(), ack: player?.seq ?? 0 };
    const state = this.view(this.match.state, connection.playerId);
    if (!connection.encoder) return this.send(ws, { t: 'snap', ...header, state });
    const encoded = connection.encoder.encode(state);
    if (encoded.kind === 'full') this.send(ws, { t: 'snap', ...header, frame: encoded.frame, state });
    else this.send(ws, { t: 'delta', ...header, frame: encoded.frame, base: encoded.base, patch: encoded.patch });
  }

  // ---- Alarms -------------------------------------------------------------

  async alarm(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    const now = Date.now();

    if (meta.phaseEndsAt && meta.phaseEndsAt <= now) {
      if (meta.phase === 'countdown') this.beginMatch();
      else if (meta.phase === 'results') {
        meta.phase = 'lobby';
        meta.phaseEndsAt = null;
        meta.results = null;
      }
    }

    // Close sockets that have gone silent (no heartbeat, no messages).
    for (const ws of this.ctx.getWebSockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const attachment = ws.deserializeAttachment() as { at?: number } | null;
      if (Math.max(last, attachment?.at ?? 0) + this.config.idleMs < now) {
        ws.close(CLOSE.IDLE, 'Idle');
        await this.dropped(ws);
      }
    }

    // Release slots whose hold has run out.
    for (const player of [...meta.players])
      if (!player.bot && !player.connected && player.heldUntil && player.heldUntil <= now) this.remove(player.id);

    if (!meta.players.some((p) => !p.bot) && (meta.emptySince ?? meta.createdAt) + this.config.emptyMs <= now) {
      await this.close();
      return;
    }
    await this.commit();
  }

  /** Persist, tell everyone, update the listing and reschedule the alarm. */
  private async commit() {
    const meta = this.meta;
    if (!meta) return;
    this.syncBots();
    await this.save();
    this.broadcastRoom();
    const now = Date.now();
    const humans = meta.players.filter((p) => !p.bot);
    if (humans.length) delete meta.emptySince;
    else meta.emptySince ??= now;
    const humansOnline = humans.some((p) => p.connected);
    if (humansOnline && meta.settings.public) {
      const listing = this.listing();
      if (!meta.listed || now >= this.renewAt || JSON.stringify(listing) !== this.lastListing) void this.publish(listing);
    } else if (meta.listed) void this.unpublish();

    const due = [
      meta.phaseEndsAt,
      humansOnline ? now + RENEW_MS : null,
      ...meta.players.map((p) => p.heldUntil ?? null),
      meta.players.some((p) => !p.bot) ? null : (meta.emptySince ?? meta.createdAt) + this.config.emptyMs,
    ].filter((t): t is number => typeof t === 'number');
    if (due.length) await this.schedule(Math.min(...due));
    else await this.ctx.storage.deleteAlarm();
  }

  private async schedule(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current < Date.now()) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1));
  }

  private async close() {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE.CLOSED, 'Room closed');
    if (this.meta?.listed) await this.unpublish();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.meta = null;
    this.connections.clear();
  }

  // ---- Directory ----------------------------------------------------------

  private directory(): DurableObjectStub<LobbyDirectory> | null {
    const ns = (this.env as Record<string, unknown>)[this.config.directoryBinding] as
      | DurableObjectNamespace<LobbyDirectory>
      | undefined;
    return ns ? ns.getByName('global') : null;
  }

  private listing() {
    const meta = this.meta!;
    return {
      code: meta.code,
      name: meta.settings.name,
      players: meta.players.length,
      maxPlayers: Math.min(meta.settings.maxPlayers, this.config.maxPlayers),
      phase: meta.phase,
      public: meta.settings.public,
    };
  }

  private publish(listing: ReturnType<GameRoom<State, Input, Env>['listing']>) {
    this.renewAt = Date.now() + RENEW_MS;
    this.lastListing = JSON.stringify(listing);
    this.meta!.listed = true;
    return this.directoryQueue.run(async () => {
      try {
        await this.directory()?.put(listing);
      } catch (err) {
        console.warn('lobbyboi: directory publish failed', err);
      }
    });
  }

  private unpublish() {
    const meta = this.meta!;
    meta.listed = false;
    this.lastListing = '';
    const code = meta.code;
    return this.directoryQueue.run(async () => {
      try {
        await this.directory()?.remove(code);
      } catch (err) {
        console.warn('lobbyboi: directory remove failed', err);
      }
    });
  }

  // ---- Helpers ------------------------------------------------------------

  private context(tick = this.match?.tick ?? 0): MatchContext<Input> {
    const meta = this.meta!;
    return {
      players: meta.players.map(publicPlayer),
      settings: meta.settings,
      inputs: this.inputs,
      tick,
      dt: 1 / this.config.tickHz,
      emit: (name, data, to) => {
        const message: ServerMessage = { t: 'event', name, data: data ?? null };
        if (to) for (const ws of this.ctx.getWebSockets(to)) this.send(ws, message);
        else this.broadcast(message);
      },
    };
  }

  private cleanSettings(next: RoomSettings, previous: RoomSettings): RoomSettings {
    const cap = this.config.maxPlayers;
    return {
      name: typeof next.name === 'string' && next.name.trim() ? next.name.trim().slice(0, 40) : previous.name,
      public: typeof next.public === 'boolean' ? next.public : previous.public,
      maxPlayers: clampInt(next.maxPlayers, 1, cap, previous.maxPlayers ?? cap),
      bots: clampInt(next.bots, 0, cap - 1, previous.bots ?? 0),
      custom: this.parseSettings(next.custom && typeof next.custom === 'object' ? next.custom : {}),
    };
  }

  /** Keep the number of bots at settings.bots without crowding out humans. */
  private syncBots() {
    const meta = this.meta!;
    const cap = Math.min(meta.settings.maxPlayers, this.config.maxPlayers);
    const humans = meta.players.filter((p) => !p.bot).length;
    const target = Math.max(0, Math.min(meta.settings.bots, cap - humans));
    const bots = meta.players.filter((p) => p.bot);
    for (const bot of bots.slice(target)) this.remove(bot.id);
    const taken = new Set(meta.players.map((p) => p.name));
    for (let i = bots.length; i < target; i++) {
      const name = this.config.botNames.find((n) => !taken.has(n)) ?? `Bot ${i + 1}`;
      taken.add(name);
      const bot: PlayerRecord = {
        id: `bot:${crypto.randomUUID().slice(0, 8)}`,
        name,
        bot: true,
        ready: true,
        connected: true,
        joinedAt: Date.now(),
        seq: 0,
      };
      meta.players.push(bot);
      if (this.match && meta.phase === 'playing') this.onJoin(this.match.state, publicPlayer(bot), this.context());
    }
  }

  private remove(playerId: string) {
    const meta = this.meta!;
    const index = meta.players.findIndex((p) => p.id === playerId);
    if (index < 0) return;
    meta.players.splice(index, 1);
    this.inputs.delete(playerId);
    if (this.match && meta.phase === 'playing') this.onLeave(this.match.state, playerId, this.context());
    if (meta.hostId === playerId) this.migrateHost();
  }

  private migrateHost() {
    const meta = this.meta!;
    const next = meta.players.find((p) => !p.bot && p.connected && p.id !== meta.hostId);
    if (next) meta.hostId = next.id;
    else if (!meta.players.some((p) => p.id === meta.hostId)) meta.hostId = null;
  }

  private isConnected(playerId: string) {
    return this.ctx.getWebSockets(playerId).some((ws) => this.connections.has(ws) && ws.readyState === WebSocket.OPEN);
  }

  private rehydrate(ws: WebSocket): Connection | undefined {
    const attachment = ws.deserializeAttachment() as { playerId?: string } | null;
    if (!attachment?.playerId) return undefined;
    const connection = this.connection(attachment.playerId);
    this.connections.set(ws, connection);
    return connection;
  }

  private roomInfo(): RoomInfo {
    const meta = this.meta!;
    return {
      code: meta.code,
      phase: meta.phase,
      hostId: meta.hostId,
      players: meta.players.map(publicPlayer),
      settings: meta.settings,
      phaseEndsAt: meta.phaseEndsAt,
      results: meta.results,
    };
  }

  private async save() {
    if (this.meta) await this.ctx.storage.put('meta', this.meta);
  }

  private broadcastRoom() {
    if (this.meta) this.broadcast({ t: 'room', room: this.roomInfo() });
  }

  protected broadcast(message: ServerMessage) {
    const text = JSON.stringify(message);
    for (const ws of this.connections.keys()) safeSend(ws, text);
  }

  protected send(ws: WebSocket, message: ServerMessage) {
    safeSend(ws, JSON.stringify(message));
  }

  private reject(ws: WebSocket, code: string) {
    this.send(ws, { t: 'error', code, message: REFUSALS[code] ?? code });
  }
}

const REFUSALS: Record<string, string> = {
  full: 'The room is full',
  in_progress: 'A match is already in progress',
  not_host: 'Only the host can do that',
  not_ready: 'Everyone needs to be ready',
  not_enough_players: 'Not enough players to start',
  bad_meta: 'Player metadata must be an object under 512 bytes',
  unknown_message: 'Unknown message type',
};

const publicPlayer = ({ id, name, bot, ready, connected, meta }: PlayerRecord): PlayerInfo => ({
  id,
  name,
  bot,
  ready,
  connected,
  ...(meta ? { meta } : {}),
});

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function safeSend(ws: WebSocket, text: string) {
  try {
    ws.send(text);
  } catch {
    // Socket already closing; its close handler will clean up.
  }
}
