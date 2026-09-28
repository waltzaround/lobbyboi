// The lobby directory: one Durable Object that lists open rooms.
//
// Listings are leases, not facts. Each room re-publishes itself while it has
// people in it; a room that crashes, is evicted or is simply forgotten drops off
// the list when its lease runs out. Nothing ever has to clean up after a room.

import { DurableObject } from 'cloudflare:workers';
import type { Listing } from '../protocol.js';
import { error, json, readBody, ROOM_CODE } from './util.js';

export const LEASE_MS = 45_000;
export const RENEW_MS = 15_000;
const PREFIX = 'room:';

export class LobbyDirectory<Env = unknown> extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.pathname.match(/^\/rooms\/([^/]+)$/)?.[1];

    if (request.method === 'GET' && url.pathname === '/rooms') {
      return json(await this.list({ joinable: url.searchParams.get('all') !== '1' }));
    }
    if (code && ROOM_CODE.test(code)) {
      if (request.method === 'PUT') {
        const body = await readBody<Omit<Listing, 'code' | 'updatedAt' | 'expiresAt'>>(request);
        await this.put({ ...body, code });
        return json({ ok: true });
      }
      if (request.method === 'DELETE') {
        await this.remove(code);
        return json({ ok: true });
      }
    }
    return error('not_found', 'Unknown directory route', 404);
  }

  async put(listing: Omit<Listing, 'updatedAt' | 'expiresAt'>) {
    const now = Date.now();
    await this.ctx.storage.put(PREFIX + listing.code, { ...listing, updatedAt: now, expiresAt: now + LEASE_MS });
  }

  async remove(code: string) {
    await this.ctx.storage.delete(PREFIX + code);
  }

  /** Public rooms, most players first. With `joinable`, only lobbies with space. */
  async list({ joinable = true } = {}): Promise<Listing[]> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<Listing>({ prefix: PREFIX });
    const expired: string[] = [];
    const live: Listing[] = [];
    for (const [key, listing] of entries) {
      if (listing.expiresAt <= now) expired.push(key);
      else live.push(listing);
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    return live
      .filter((listing) => listing.public && (!joinable || (listing.phase === 'lobby' && listing.players < listing.maxPlayers)))
      .sort((a, b) => b.players - a.players || a.updatedAt - b.updatedAt);
  }
}
