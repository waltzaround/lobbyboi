# lobbyboi

Multiplayer rooms for Cloudflare Durable Objects: lobbies, quick-match, authoritative netcode and bots, in one small TypeScript package.

**[lobbyboi.walt.online](https://lobbyboi.walt.online)** · [Play the demo](https://lobbyboi.walt.online/play/)

You write the game (`createGame`, `step` and `view`). lobbyboi runs everything around it:

- **Rooms and lobbies**: shareable room codes, a public room list, quick-match, ready-up, host controls, kick, chat
- **Match lifecycle**: `lobby → countdown → playing → results → lobby`, driven by alarms
- **Connections**: signed guest sessions, one socket per player, reconnect with a held slot, host migration, and idle rooms that hibernate and then clean themselves up
- **Netcode**: a fixed-step authoritative tick; sequenced, validated and rate-limited inputs; `ack` for client prediction; per-connection delta snapshots; a client interpolation buffer with server clock sync
- **Bots**: bots fill empty seats and give them up to humans. Their inputs go through the same path as players'

No runtime dependencies. The server is about 1,500 lines of TypeScript. The client adds about 6 KB gzipped.

```ts
import { GameRoom, LobbyDirectory, createLobby, type MatchContext } from 'lobbyboi/server';

export class TagRoom extends GameRoom<State, Input> {
  static config = { maxPlayers: 8, tickHz: 30, snapshotHz: 15 };

  createGame(ctx: MatchContext<Input>) { return spawnEveryone(ctx.players); }
  step(state: State, ctx: MatchContext<Input>) {
    for (const [id, input] of ctx.inputs) movePlayer(state, id, input, ctx.dt);
    if (ctx.tick >= 60 * 30) return { winner: leader(state) }; // returning ends the match
  }
  view(state: State, playerId: string) { return { players: state.players }; }
  botInput(state: State, botId: string) { return chaseNearest(state, botId); }
}

export { LobbyDirectory };
const lobby = createLobby({ rooms: 'ROOMS' });
export default { fetch: async (req, env) => (await lobby(req, env)) ?? env.ASSETS.fetch(req) };
```

```ts
import { LobbyClient, Interpolator } from 'lobbyboi/client';

const lobby = new LobbyClient();
await lobby.login('Walt');
const room = lobby.join<View, Input>(await lobby.quickMatch());

room.on('room', (info) => renderLobby(info));      // players, phase, host, settings
room.on('snapshot', ({ time, state }) => others.push(time, state.players));
setInterval(() => room.sendInput(readKeys()), 1000 / 30);
```

## Try the example

[`examples/arena`](examples/arena) is **Coin Rush**, a complete game in about 600 lines. You grab coins and dash into people to knock theirs loose. It has a lobby UI, bots, client-side prediction with reconciliation, and interpolation.

```bash
pnpm install
```

```bash
pnpm dev
```

Open the Vite URL, create a room and hit Start. The example ships with three bots. To play against yourself, open a private window, which gets a separate session.

The project website lives in [`site`](site): a landing page plus Coin Rush at `/play/`, deployed as one Worker. Run it with `pnpm site`, and deploy it with `pnpm run deploy`.

## Setup

**1. Wrangler config.** Add a Durable Object binding for your room class and one for the directory:

```jsonc
{
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-20",
  "assets": { "directory": "./dist", "run_worker_first": ["/api/*"] },
  "durable_objects": {
    "bindings": [
      { "name": "ROOMS", "class_name": "TagRoom" },
      { "name": "LOBBY", "class_name": "LobbyDirectory" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TagRoom", "LobbyDirectory"] }]
}
```

**2. A session secret.** Sessions are HMAC-signed, so you need a secret of at least 16 characters:

```bash
npx wrangler secret put SESSION_SECRET
```

For local development, put `SESSION_SECRET=...` in `.dev.vars`. The example's `scripts/setup.mjs` generates one for you.

**3. Write the room**, then mount `createLobby()` in the Worker as in the snippet above.

## How it works

### One Durable Object per room

Each room code maps to one `GameRoom` instance (`getByName("room:CODE")`), so all players in a room share one process and one source of truth. The Worker verifies the player's session and forwards the WebSocket upgrade with the identity in a header. Rooms never trust anything the client says about who it is.

```
browser ──HTTP──▶ Worker (createLobby) ──RPC──▶ LobbyDirectory   (one, lists open rooms)
   │                     │
   └──WebSocket──────────┴──upgrade + identity──▶ GameRoom "room:K7QX2"   (one per room)
```

### Time: alarms when idle, a loop when playing

Lobby, countdown and results are timed with **alarms**. Heartbeats are answered by the runtime's WebSocket auto-response, so a lobby full of idle players **hibernates** and costs nothing. During `playing`, a `setInterval` runs a fixed-step loop with an accumulator (at most 5 catch-up steps). That keeps the object awake, but a match in progress is receiving input every frame anyway.

If a room restarts mid-match (a deploy or an eviction), match state is gone because it lives in memory. The room falls back to the lobby and emits `match_aborted`. The lobby itself (players, host, settings) is persisted and survives.

### Joining, leaving and coming back

- **One socket per player.** A newer socket replaces an older one (close `4001`), which is how refreshing a tab works.
- **Dropped players keep their slot** for `lobbyReconnectMs` (15 s) in the lobby and `reconnectMs` (60 s) in a match. The client reconnects with jittered exponential backoff and doesn't retry after being kicked, replaced or refused.
- **The host role moves** to the next connected human when the host leaves or drops.
- **Changing settings un-readies everyone**, so nobody agrees to a game they didn't see.
- **Joining during a countdown cancels it.** Joining mid-match calls `onJoin` (turn this off with `joinInProgress: false`).
- **An empty room deletes itself** after `emptyMs`, including its storage and its listing.

### Room list and quick-match

Rooms publish themselves to the `LobbyDirectory` as **leases** (45 s, renewed every 15 s while anyone is connected). A room that crashes or is forgotten drops off the list without cleanup code.

Quick-match uses **reserve-then-join**. A listing may be stale, so quick-match asks the fullest few rooms to *reserve* a slot (held for 20 s). It only sends the player to a room that says yes, and creates a new public room if none do.

### Netcode

- **Inputs** carry a sequence number. The server drops stale, replayed, invalid (`parseInput` returns `null`), oversized (4 KB) or flooding (90/s) messages. The last two close the socket.
- **Latest input wins.** `ctx.inputs` holds each player's most recent input, and `step()` reads it. For one-shot actions, detect edges in your game state as the example's dash does, or consume and clear the input.
- **Snapshots** come from `view(state, playerId)`, so each player can see a different slice (fog of war, hidden hands). They are sent at `snapshotHz` with the server `time` and your `ack` (the last input sequence applied).
- **Deltas.** Each connection gets its own delta encoder. Top-level fields are diffed as a whole. Arrays of `{ id }` objects are diffed per entity and per field, so a moving player costs `{"id":"a","set":{"x":412}}`. Keyframes go out every 60 frames and whenever a delta isn't smaller than the full state. If the client loses its baseline, it asks for a resync.
- **Client side**, `RoomConnection` tracks RTT and the server clock offset. `Interpolator` renders remote entities about 100 ms in the past, interpolated between snapshots, with bounded extrapolation when packets are late. For your own player, predict with the same movement code and reconcile using `ack`. [`examples/arena/src/client/main.ts`](examples/arena/src/client/main.ts) does exactly this in about 20 lines.

### Bots

`settings.bots` is how many seats bots should fill. Bots never take a seat a human needs; when a human joins a full room, a bot leaves. Every tick, `botInput(state, botId, ctx)` produces an input that goes into `ctx.inputs` exactly like a human's, so game rules apply to bots automatically.

## Reference

### Game hooks

| Method | Required | |
|---|---|---|
| `createGame(ctx)` | yes | Initial state when the countdown ends. `ctx.players` includes bots. |
| `step(state, ctx)` | yes | One fixed step. Read `ctx.inputs`, mutate `state`. Return anything to end the match; it becomes `room.results`. |
| `view(state, playerId)` | yes | What this player may see, as plain JSON. |
| `parseInput(raw)` | | Validate and normalise input. Return `null` to drop it. |
| `botInput(state, botId, ctx)` | | A bot's input for this tick. |
| `onJoin(state, player, ctx)` / `onLeave(state, id, ctx)` | | Players joining or leaving mid-match. |
| `parseSettings(custom)` | | Validate host-chosen custom settings. Throw to reject them with a message. |

`ctx` also has `tick`, `dt` (seconds per step), `settings`, and `emit(name, data, to?)` for one-off events such as sounds or kill feeds.

### Config

Set `static config = { ... }` on your room. Defaults:

| Option | Default | |
|---|---|---|
| `maxPlayers` / `minPlayers` | 8 / 1 | Humans plus bots |
| `tickHz` / `snapshotHz` | 30 / 15 | `snapshotHz` must divide `tickHz` |
| `countdownMs` / `resultsMs` | 3000 / 8000 | |
| `lobbyReconnectMs` / `reconnectMs` | 15 000 / 60 000 | Slot hold after a drop |
| `reservationMs` / `emptyMs` | 20 000 / 60 000 | Quick-match hold; empty-room lifetime |
| `joinInProgress` / `autoStart` | true / false | `autoStart` starts when everyone is ready |
| `delta` / `keyframeEvery` | true / 60 | |
| `maxMessageBytes` / `messagesPerSecond` / `idleMs` | 4096 / 90 / 45 000 | |
| `directoryBinding` | `'LOBBY'` | Rooms are unlisted if it's missing |
| `settings` | `{}` | Default room settings: `name`, `public`, `maxPlayers`, `bots`, `custom` |

### HTTP routes

Mounted under `/api` by default.

| | |
|---|---|
| `POST /session {name}` | Issue or rename a guest session (cookie, plus a token for cross-origin use) |
| `GET /session` | Current identity |
| `GET /rooms` | Public lobbies with space, fullest first |
| `POST /rooms {settings}` | Create a room and return `{code}` |
| `GET /rooms/:code` | Room info |
| `POST /quickmatch` | Reserve a seat in an open lobby, or create one: `{code, created}` |
| `GET /rooms/:code/ws?v=1` | WebSocket. Cross-site origins are refused unless listed in `allowedOrigins`. |

### Close codes

`4000` idle, `4001` replaced by a newer connection, `4002` kicked, `4003` protocol version mismatch, `4004` room closed or refused, `1007` invalid message, `1008` rate limited. The client doesn't reconnect after `4001`–`4004` or `1008`.

## Testing

```bash
pnpm test
```

36 tests. The integration tests run in the real Workers runtime through `@cloudflare/vitest-pool-workers` and open real WebSockets through the Worker. They cover sessions and forgery, codes, capacity, replacement, reconnect holds, host migration, host-only actions, kicks, rate limits, bots, the full match lifecycle, input sequencing, deltas, join-in-progress, the directory and quick-match. The unit tests fuzz the delta codec's round-trip and cover interpolation and rate limiting.

## Not included (yet)

- **Lag compensation / rewind** for hitscan. Add it in `step()` using the snapshot `time`.
- **Deterministic lockstep** for RTS-style games with hundreds of units. lobbyboi's model is server-authoritative snapshots.
- **Binary encoding.** It's JSON everywhere; deltas keep it small, but a MessagePack or bit-packed codec would plug in at `send`.
- **Regions and skill-based matching.** The directory is one global object, and quick-match picks the fullest room.
- **Spectators.**

## License

MIT
