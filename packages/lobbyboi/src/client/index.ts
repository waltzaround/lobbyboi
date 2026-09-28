import type { Listing, RoomInfo, RoomSettings } from '../protocol.js';
import { RoomConnection, type ConnectOptions } from './connection.js';

export { RoomConnection, type Snapshot, type Status, type ConnectionEvents, type ConnectOptions } from './connection.js';
export { Interpolator, lerpAngle, type Entity, type InterpolationOptions } from './interpolation.js';
export * from '../protocol.js';

export interface LobbyClientOptions {
  /** Origin of the Worker. Default: the page's origin. */
  baseUrl?: string;
  /** Route prefix used by createLobby(). Default /api. */
  prefix?: string;
  /**
   * Send the session token explicitly instead of relying on the cookie. Needed
   * when the game is served from a different origin than the Worker.
   */
  useToken?: boolean;
}

export class LobbyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** HTTP side of the lobby: sessions, room lists, create, quick-match, join. */
export class LobbyClient {
  private base: string;
  private token: string | null = null;
  me: { id: string; name: string } | null = null;

  constructor(private options: LobbyClientOptions = {}) {
    const origin = options.baseUrl ?? globalThis.location?.origin;
    if (!origin) throw new Error('lobbyboi: pass baseUrl outside the browser');
    this.base = origin.replace(/\/$/, '') + (options.prefix ?? '/api');
  }

  /** Start or rename a guest session. Call before anything else. */
  async login(name?: string) {
    const session = await this.request<{ id: string; name: string; token: string }>('POST', '/session', { name });
    if (this.options.useToken) this.token = session.token;
    this.me = { id: session.id, name: session.name };
    return this.me;
  }

  /** Resume an existing cookie session, if there is one. */
  async resume() {
    try {
      this.me = await this.request<{ id: string; name: string }>('GET', '/session');
      return this.me;
    } catch {
      return null;
    }
  }

  rooms() {
    return this.request<Listing[]>('GET', '/rooms');
  }

  info(code: string) {
    return this.request<RoomInfo>('GET', `/rooms/${encodeURIComponent(code.toUpperCase())}`);
  }

  async create(settings: Partial<RoomSettings> = {}) {
    return (await this.request<{ code: string }>('POST', '/rooms', { settings })).code;
  }

  async quickMatch() {
    return (await this.request<{ code: string; created: boolean }>('POST', '/quickmatch', {})).code;
  }

  join<State = Record<string, unknown>, Input = unknown>(
    code: string,
    options: Omit<ConnectOptions, 'url' | 'token'> = {},
  ): RoomConnection<State, Input> {
    const url = new URL(`${this.base}/rooms/${encodeURIComponent(code.toUpperCase())}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new RoomConnection<State, Input>({ ...options, url: url.toString(), token: this.token ?? undefined });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers['X-Lobbyboi-Session'] = this.token;
    const response = await fetch(this.base + path, {
      method,
      headers,
      credentials: this.options.useToken ? 'omit' : 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = data as { error?: string; message?: string };
      throw new LobbyError(err.error ?? 'http_error', err.message ?? response.statusText, response.status);
    }
    return data as T;
  }
}
