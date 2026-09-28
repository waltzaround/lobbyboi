import { SELF } from 'cloudflare:test';
import type { RoomInfo, ServerMessage } from '../src/protocol.js';

export const ORIGIN = 'https://game.test';

export async function api<T = any>(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('X-Lobbyboi-Session', init.token);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await SELF.fetch(ORIGIN + '/api' + path, { ...init, headers });
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

export async function login(name: string) {
  const { body } = await api<{ id: string; name: string; token: string }>('/session', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return body;
}

export async function createRoom(token: string, settings: Record<string, unknown> = {}) {
  const { body } = await api<{ code: string }>('/rooms', { method: 'POST', token, body: JSON.stringify({ settings }) });
  return body.code;
}

/** A test-side socket that records every message and close. */
export class Client {
  messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  room: RoomInfo | null = null;
  you: string | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      this.messages.push(message);
      if (message.t === 'welcome') {
        this.you = message.you;
        this.room = message.room;
      }
      if (message.t === 'room') this.room = message.room;
      this.wake();
    });
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
  }

  send(message: unknown) {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Wait until `predicate` holds, checking after every message. */
  async until(predicate: (client: this) => unknown, timeout = 3000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!predicate(this)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(this.messages.slice(-3))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 50));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async next<T extends ServerMessage['t']>(t: T, timeout = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const start = this.messages.length;
    let found: ServerMessage | undefined;
    await this.until(() => (found = this.messages.slice(start).find((m) => m.t === t)), timeout, `"${t}"`);
    return found as Extract<ServerMessage, { t: T }>;
  }

  close() {
    this.ws.close(1000);
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

export async function connect(code: string, token: string, { version = 1, origin }: { version?: number; origin?: string } = {}) {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (origin) headers.Origin = origin;
  const response = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws?v=${version}&session=${token}`, { headers });
  if (!response.webSocket) return { response, client: null };
  response.webSocket.accept();
  return { response, client: new Client(response.webSocket) };
}

/** Connect and wait for the welcome. */
export async function join(code: string, token: string) {
  const { client, response } = await connect(code, token);
  if (!client) throw new Error(`Upgrade failed: ${response.status} ${await response.text()}`);
  await client.until((c) => c.you, 3000, 'welcome');
  return client;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
