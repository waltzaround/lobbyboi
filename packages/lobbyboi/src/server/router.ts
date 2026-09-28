// HTTP routes for the Worker. Mount it in front of your own routes and assets:
//
//   const lobby = createLobby({ rooms: 'ROOMS' });
//   export default {
//     fetch: (request, env, ctx) => lobby(request, env) ?? env.ASSETS.fetch(request),
//   };
//
// Routes (under `prefix`, default /api):
//   POST /session            { name }      issue or rename a guest session
//   GET  /session                          who am I
//   GET  /rooms                            public lobbies with space
//   POST /rooms              { settings }  create a room, returns { code }
//   GET  /rooms/:code                      room info
//   POST /quickmatch                       join the fullest open lobby, or create one
//   GET  /rooms/:code/ws?v=1               WebSocket upgrade

import type { RoomSettings } from '../protocol.js';
import type { LobbyDirectory } from './directory.js';
import { PLAYER_HEADER, type GameRoom } from './room.js';
import { issueSession, readSession, type Identity } from './session.js';
import { error, json, readBody, ROOM_CODE, roomCode } from './util.js';

export interface LobbyOptions<Env> {
  /** Env binding name of your GameRoom subclass. */
  rooms: string;
  /** Env binding name of the LobbyDirectory. Default 'LOBBY'. */
  directory?: string;
  /** Where to find the session signing secret. Default env.SESSION_SECRET. */
  secret?: (env: Env) => string | undefined;
  prefix?: string;
  codeLength?: number;
  /**
   * Origins allowed to open WebSockets, besides the Worker's own. Blocks other
   * sites from using a visitor's cookie to join rooms as them.
   */
  allowedOrigins?: string[];
}

type AnyRoom = GameRoom<unknown, unknown, unknown>;

export function createLobby<Env extends object>(options: LobbyOptions<Env>) {
  const prefix = options.prefix ?? '/api';
  const directoryName = options.directory ?? 'LOBBY';
  const getSecret = options.secret ?? ((env: Env) => (env as Record<string, unknown>).SESSION_SECRET as string | undefined);
  const codeLength = options.codeLength ?? 5;

  const rooms = (env: Env) => {
    const ns = (env as Record<string, unknown>)[options.rooms] as DurableObjectNamespace<AnyRoom> | undefined;
    if (!ns) throw new Error(`lobbyboi: no Durable Object binding named ${options.rooms}`);
    return ns;
  };
  const directory = (env: Env) => {
    const ns = (env as Record<string, unknown>)[directoryName] as DurableObjectNamespace<LobbyDirectory> | undefined;
    return ns?.getByName('global') ?? null;
  };
  const room = (env: Env, code: string) => rooms(env).getByName(`room:${code}`);

  async function create(env: Env, settings: Partial<RoomSettings>) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = roomCode(codeLength);
      if (await room(env, code).init(code, settings)) return code;
    }
    throw new Error('Could not find a free room code');
  }

  async function handle(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix + '/')) return null;
    const path = url.pathname.slice(prefix.length);
    const secret = getSecret(env);
    if (!secret || secret.length < 16)
      return error('misconfigured', 'Set a SESSION_SECRET of at least 16 characters', 500);
    const method = request.method;

    if (path === '/session') {
      if (method === 'POST') {
        const body = await readBody<{ name?: unknown }>(request).catch(() => null);
        if (!body) return error('bad_request', 'Invalid JSON');
        return issueSession(request, secret, body.name);
      }
      if (method === 'GET') {
        const identity = await readSession(request, secret);
        return identity ? json({ id: identity.id, name: identity.name }) : error('unauthorized', 'No session', 401);
      }
    }

    if (path === '/rooms' && method === 'GET') {
      const dir = directory(env);
      return json(dir ? await dir.list() : []);
    }

    const identity = await readSession(request, secret);

    if (path === '/rooms' && method === 'POST') {
      if (!identity) return error('unauthorized', 'Create a session first', 401);
      const body = await readBody<{ settings?: Partial<RoomSettings> }>(request).catch(() => null);
      if (!body) return error('bad_request', 'Invalid JSON');
      return json({ code: await create(env, body.settings ?? {}) }, 201);
    }

    if (path === '/quickmatch' && method === 'POST') {
      if (!identity) return error('unauthorized', 'Create a session first', 401);
      const dir = directory(env);
      const open = dir ? await dir.list() : [];
      // Reserve-then-join: a listing can be stale, so only a successful
      // reservation counts. Try the fullest few, then make a new room.
      for (const listing of open.slice(0, 5)) {
        const refusal = await room(env, listing.code).reserve(player(identity)).catch(() => 'gone');
        if (refusal === null) return json({ code: listing.code, created: false });
      }
      return json({ code: await create(env, { public: true }), created: true }, 201);
    }

    const match = path.match(/^\/rooms\/([A-Za-z0-9]+)(\/ws)?$/);
    if (match) {
      const code = match[1]!.toUpperCase();
      if (!ROOM_CODE.test(code)) return error('not_found', 'No such room', 404);
      if (!match[2] && method === 'GET') {
        const info = await room(env, code).info();
        return info ? json(info) : error('not_found', 'No such room', 404);
      }
      if (match[2] && method === 'GET') {
        if (!identity) return error('unauthorized', 'Create a session first', 401);
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin && !options.allowedOrigins?.includes(origin))
          return error('forbidden', 'Origin not allowed', 403);
        const headers = new Headers({ Upgrade: 'websocket', [PLAYER_HEADER]: JSON.stringify(player(identity)) });
        return room(env, code).fetch(new Request(`https://room/connect${url.search}`, { headers }));
      }
    }

    return error('not_found', 'Unknown lobby route', 404);
  }

  return async (request: Request, env: Env): Promise<Response | null> => {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error('lobbyboi:', err);
      return error('internal', 'Something went wrong', 500);
    }
  };
}

const player = (identity: Identity) => ({ id: identity.id, name: identity.name });
