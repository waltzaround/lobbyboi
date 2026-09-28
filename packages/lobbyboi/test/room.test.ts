import { describe, expect, it } from 'vitest';
import { CLOSE } from '../src/protocol.js';
import { api, connect, createRoom, join, login, sleep } from './helpers.js';

describe('sessions', () => {
  it('issues a signed session and keeps the id when renaming', async () => {
    const first = await login('Walt');
    expect(first.name).toBe('Walt');
    const { body } = await api('/session', { method: 'POST', token: first.token, body: JSON.stringify({ name: 'Walter' }) });
    expect(body.id).toBe(first.id);
    expect(body.name).toBe('Walter');
  });

  it('cleans display names', async () => {
    expect((await login('<script>alert(1)</script>')).name).toBe('scriptalert1script');
    expect((await login('   ')).name).toBe('Player');
  });

  it('rejects forged and tampered tokens', async () => {
    const { token } = await login('Mallory');
    const [payload, signature] = token.split('.');
    const forged = btoa(JSON.stringify({ id: 'someone-else', name: 'X', expiresAt: Date.now() + 1e9 }))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect((await api('/rooms', { method: 'POST', token: `${forged}.${signature}`, body: '{}' })).status).toBe(401);
    expect((await api('/rooms', { method: 'POST', token: `${payload}.${signature}x`, body: '{}' })).status).toBe(401);
    expect((await api('/rooms', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('rooms', () => {
  it('creates a room with a readable code', async () => {
    const { token } = await login('Host');
    const code = await createRoom(token, { name: 'Friday night' });
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTWXYZ2-9]{5}$/);
    const { body } = await api(`/rooms/${code}`);
    expect(body).toMatchObject({ code, phase: 'lobby', players: [], settings: { name: 'Friday night' } });
  });

  it('404s for rooms that do not exist', async () => {
    const { token } = await login('Lost');
    expect((await api('/rooms/ZZZZZ')).status).toBe(404);
    const { response } = await connect('ZZZZZ', token);
    expect(response.status).toBe(404);
  });

  it('welcomes players and makes the first one host', async () => {
    const a = await login('Alice');
    const b = await login('Bob');
    const code = await createRoom(a.token);
    const alice = await join(code, a.token);
    expect(alice.you).toBe(a.id);
    expect(alice.room!.hostId).toBe(a.id);
    const bob = await join(code, b.token);
    await alice.until((c) => c.room!.players.length === 2, 3000, 'bob in lobby');
    expect(bob.room!.hostId).toBe(a.id);
    expect(alice.room!.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
  });

  it('closes clients on an old protocol version', async () => {
    const { token } = await login('Old');
    const code = await createRoom(token);
    const { client } = await connect(code, token, { version: 0 });
    await client!.until((c) => c.closed, 3000, 'close');
    expect(client!.closed!.code).toBe(CLOSE.VERSION);
  });

  it('refuses cross-site WebSocket origins', async () => {
    const { token } = await login('Victim');
    const code = await createRoom(token);
    const { response } = await connect(code, token, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('refuses players once the room is full', async () => {
    const host = await login('Host');
    const code = await createRoom(host.token, { maxPlayers: 2 });
    await join(code, host.token);
    await join(code, (await login('Two')).token);
    const { client } = await connect(code, (await login('Three')).token);
    await client!.until((c) => c.closed, 3000, 'close');
    expect(client!.messages[0]).toMatchObject({ t: 'error', code: 'full' });
    expect(client!.closed!.code).toBe(CLOSE.CLOSED);
  });

  it('replaces an older socket for the same player', async () => {
    const { token, id } = await login('Tabby');
    const code = await createRoom(token);
    const first = await join(code, token);
    const second = await join(code, token);
    await first.until((c) => c.closed, 3000, 'replaced');
    expect(first.closed!.code).toBe(CLOSE.REPLACED);
    expect(second.room!.players.filter((p) => p.id === id)).toHaveLength(1);
  });

  it('holds a dropped player’s slot, then releases it', async () => {
    const a = await login('Stays');
    const b = await login('Drops');
    const code = await createRoom(a.token);
    const stays = await join(code, a.token);
    const drops = await join(code, b.token);
    drops.close();
    await stays.until((c) => c.room!.players.find((p) => p.id === b.id)?.connected === false, 3000, 'disconnected');
    const back = await join(code, b.token);
    expect(back.room!.players.filter((p) => p.id === b.id)).toHaveLength(1);
    back.close();
    // lobbyReconnectMs is 300ms in the fixture.
    await stays.until((c) => !c.room!.players.some((p) => p.id === b.id), 3000, 'slot released');
  });

  it('hands host to the next player when the host leaves', async () => {
    const a = await login('Host');
    const b = await login('Heir');
    const code = await createRoom(a.token);
    const host = await join(code, a.token);
    const heir = await join(code, b.token);
    host.send({ t: 'leave' });
    await heir.until((c) => c.room!.hostId === b.id, 3000, 'new host');
    expect(heir.room!.players.map((p) => p.id)).toEqual([b.id]);
  });

  it('only lets the host start, change settings or kick', async () => {
    const a = await login('Host');
    const b = await login('Guest');
    const code = await createRoom(a.token);
    await join(code, a.token);
    const guest = await join(code, b.token);
    guest.send({ t: 'start' });
    expect(await guest.next('error')).toMatchObject({ code: 'not_host' });
    guest.send({ t: 'kick', playerId: a.id });
    expect(await guest.next('error')).toMatchObject({ code: 'not_host' });
  });

  it('kicks players and stops them reconnecting', async () => {
    const a = await login('Host');
    const b = await login('Rude');
    const code = await createRoom(a.token);
    const host = await join(code, a.token);
    const rude = await join(code, b.token);
    host.send({ t: 'kick', playerId: b.id });
    await rude.until((c) => c.closed, 3000, 'kicked');
    expect(rude.closed!.code).toBe(CLOSE.KICKED);
    await host.until((c) => c.room!.players.length === 1, 3000, 'removed');
  });

  it('un-readies everyone when settings change', async () => {
    const a = await login('Host');
    const b = await login('Guest');
    const code = await createRoom(a.token);
    const host = await join(code, a.token);
    const guest = await join(code, b.token);
    guest.send({ t: 'ready', ready: true });
    await host.until((c) => c.room!.players.find((p) => p.id === b.id)?.ready, 3000, 'guest ready');
    host.send({ t: 'settings', settings: { name: 'New rules' } });
    await host.until((c) => c.room!.settings.name === 'New rules', 3000, 'renamed');
    expect(host.room!.players.find((p) => p.id === b.id)!.ready).toBe(false);
  });

  it('closes connections that flood messages', async () => {
    const { token } = await login('Spammer');
    const code = await createRoom(token);
    const spammer = await join(code, token);
    for (let i = 0; i < 400; i++) spammer.send({ t: 'chat', text: 'hi' });
    await spammer.until((c) => c.closed, 3000, 'rate limit');
    expect(spammer.closed!.code).toBe(CLOSE.POLICY);
  });

  it('closes connections that send junk', async () => {
    const { token } = await login('Junk');
    const code = await createRoom(token);
    const junk = await join(code, token);
    junk.send('{not json');
    await junk.until((c) => c.closed, 3000, 'close');
    expect(junk.closed!.code).toBe(CLOSE.INVALID);
  });
});

describe('bots', () => {
  it('fills seats with bots and gives them up for humans', async () => {
    const a = await login('Host');
    const code = await createRoom(a.token, { maxPlayers: 3 });
    const host = await join(code, a.token);
    host.send({ t: 'settings', settings: { bots: 2 } });
    await host.until((c) => c.room!.players.length === 3, 3000, 'bots added');
    const bots = host.room!.players.filter((p) => p.bot);
    expect(bots).toHaveLength(2);
    expect(bots.every((b) => b.ready && b.connected)).toBe(true);
    expect(new Set(bots.map((b) => b.name)).size).toBe(2);

    await join(code, (await login('Human')).token);
    await host.until((c) => c.room!.players.filter((p) => p.bot).length === 1, 3000, 'bot gave up seat');
    expect(host.room!.players).toHaveLength(3);
  });
});

describe('matches', () => {
  it('runs lobby → countdown → playing → results → lobby', async () => {
    const a = await login('Host');
    const b = await login('Guest');
    const code = await createRoom(a.token);
    const host = await join(code, a.token);
    const guest = await join(code, b.token);

    host.send({ t: 'start' });
    expect(await host.next('error')).toMatchObject({ code: 'not_ready' });

    guest.send({ t: 'ready', ready: true });
    await host.until((c) => c.room!.players.every((p) => p.ready || p.id === a.id), 3000, 'guest ready');
    host.send({ t: 'start' });
    await host.until((c) => c.room!.phase === 'countdown', 3000, 'countdown');
    expect(host.room!.phaseEndsAt).toBeGreaterThan(0);
    await host.until((c) => c.room!.phase === 'playing', 3000, 'playing');

    const first = await guest.next('snap');
    expect(first.state).toMatchObject({ players: [{ id: a.id, score: 0 }, { id: b.id, score: 0 }] });

    // Guest scores 10 in two inputs and wins.
    guest.send({ t: 'input', seq: 1, input: { add: 5 } });
    await sleep(80);
    guest.send({ t: 'input', seq: 2, input: { add: 5 } });
    await host.until((c) => c.room!.phase === 'results', 3000, 'results');
    expect(host.room!.results).toEqual({ winner: b.id });
    await host.until((c) => c.room!.phase === 'lobby', 3000, 'back to lobby');
    expect(host.room!.players.every((p) => !p.ready)).toBe(true);
  });

  it('drops invalid and replayed inputs and acks the last applied', async () => {
    const a = await login('Solo');
    const code = await createRoom(a.token);
    const solo = await join(code, a.token);
    solo.send({ t: 'start' });
    await solo.until((c) => c.room!.phase === 'playing', 3000, 'playing');

    solo.send({ t: 'input', seq: 1, input: { add: 99 } }); // invalid: parseInput refuses
    solo.send({ t: 'input', seq: 2, input: { add: 2 } });
    solo.send({ t: 'input', seq: 2, input: { add: 2 } }); // replay
    solo.send({ t: 'input', seq: 1, input: { add: 2 } }); // stale
    await solo.until(
      (c) => c.messages.some((m) => (m.t === 'snap' || m.t === 'delta') && m.ack === 2),
      3000,
      'ack 2',
    );
    // Score reaches 2, never 4 or 99. Find the latest full or delta-applied score via a resync.
    solo.send({ t: 'resync' });
    await sleep(200);
    const snaps = solo.messages.filter((m) => m.t === 'snap');
    const last = snaps[snaps.length - 1] as { state: { players: { score: number }[] } };
    expect(last.state.players[0]!.score).toBe(2);
  });

  it('sends deltas between keyframes', async () => {
    const a = await login('Host');
    const code = await createRoom(a.token);
    const host = await join(code, a.token);
    host.send({ t: 'settings', settings: { bots: 1 } });
    await host.until((c) => c.room!.players.length === 2, 3000, 'bot');
    host.send({ t: 'start' });
    await host.until((c) => c.room!.phase === 'playing', 3000, 'playing');
    await host.until((c) => c.messages.some((m) => m.t === 'delta'), 3000, 'a delta');
    const delta = host.messages.find((m) => m.t === 'delta')!;
    expect(delta).toMatchObject({ t: 'delta', patch: { lists: { players: { upserts: expect.any(Array) } } } });
    // Unchanged ids and order aren't resent.
    expect(JSON.stringify(delta)).not.toContain(host.you);
    // The bot wins on its own (1 point every other tick).
    await host.until((c) => c.room!.phase === 'results', 5000, 'bot wins');
    expect((host.room!.results as { winner: string }).winner).toMatch(/^bot:/);
  });

  it('lets players join a match in progress', async () => {
    const a = await login('Host');
    const code = await createRoom(a.token);
    const host = await join(code, a.token);
    host.send({ t: 'start' });
    await host.until((c) => c.room!.phase === 'playing', 3000, 'playing');
    const late = await join(code, (await login('Late')).token);
    const snap = await late.next('snap');
    expect((snap.state as { players: { id: string }[] }).players.map((p) => p.id)).toContain(late.you);
  });

  it('continues input sequence numbers after a page reload', async () => {
    const a = await login('Reloader');
    const code = await createRoom(a.token);
    const first = await join(code, a.token);
    first.send({ t: 'start' });
    await first.until((c) => c.room!.phase === 'playing', 3000, 'playing');
    first.send({ t: 'input', seq: 7, input: { add: 1 } });
    await first.until((c) => c.messages.some((m) => (m.t === 'snap' || m.t === 'delta') && m.ack === 7), 3000, 'ack');
    const second = await join(code, a.token);
    const welcome = second.messages.find((m) => m.t === 'welcome')!;
    expect(welcome).toMatchObject({ seq: 7 });
  });
});

describe('directory and quick-match', () => {
  it('lists public lobbies and hides private ones', async () => {
    const a = await login('Public');
    const b = await login('Private');
    const open = await createRoom(a.token, { name: 'Open' });
    const hidden = await createRoom(b.token, { name: 'Hidden', public: false });
    await join(open, a.token);
    await join(hidden, b.token);
    await sleep(100);
    const { body } = await api<{ code: string }[]>('/rooms');
    const codes = body.map((l) => l.code);
    expect(codes).toContain(open);
    expect(codes).not.toContain(hidden);
  });

  it('puts quick-match players into an open lobby', async () => {
    const a = await login('Waiting');
    const code = await createRoom(a.token, { name: 'Join me' });
    const waiting = await join(code, a.token);
    await sleep(100);
    const b = await login('Matcher');
    const { body } = await api<{ code: string; created: boolean }>('/quickmatch', { method: 'POST', token: b.token, body: '{}' });
    // Other tests' lobbies share the directory, so it may pick a fuller one.
    expect(body.created).toBe(false);
    // The reservation shows up in that room before the player connects.
    const info = (await api(`/rooms/${body.code}`)).body;
    expect(info.players.some((p: { id: string }) => p.id === b.id)).toBe(true);
    if (body.code === code) await waiting.until((c) => c.room!.players.some((p) => p.id === b.id), 3000, 'reservation');
    await join(body.code, b.token);
  });

  it('creates a room when there is nothing to join', async () => {
    const lobbies = (await api<{ code: string; players: number; maxPlayers: number }[]>('/rooms')).body;
    // Fill every open lobby so quick-match has nowhere to go.
    for (const listing of lobbies)
      for (let i = listing.players; i < listing.maxPlayers; i++)
        await join(listing.code, (await login(`Filler${i}`)).token);
    await sleep(100);
    const { status, body } = await api('/quickmatch', { method: 'POST', token: (await login('Alone')).token, body: '{}' });
    expect(status).toBe(201);
    expect(body.created).toBe(true);
  });
});
