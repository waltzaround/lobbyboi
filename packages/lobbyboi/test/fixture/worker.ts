// A tiny game for tests: everyone races to 10 points. Input { add } scores
// points; bots score one point every other tick.
import { createLobby, DEFAULT_CONFIG, GameRoom, LobbyDirectory, type MatchContext } from '../../src/server/index.js';

interface State {
  scores: Record<string, number>;
  log: string[];
}
type Input = { add: number };

export class TestRoom extends GameRoom<State, Input> {
  static config = {
    ...DEFAULT_CONFIG,
    maxPlayers: 4,
    tickHz: 20,
    snapshotHz: 10,
    countdownMs: 60,
    resultsMs: 60,
    lobbyReconnectMs: 300,
    reconnectMs: 300,
    emptyMs: 400,
  };

  protected createGame(ctx: MatchContext<Input>): State {
    return { scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])), log: [] };
  }

  protected parseInput(raw: unknown): Input | null {
    const add = (raw as Input | null)?.add;
    return Number.isInteger(add) && add! > 0 && add! <= 5 ? { add: add! } : null;
  }

  protected botInput(_state: State, _botId: string, ctx: MatchContext<Input>): Input | null {
    return ctx.tick % 2 === 0 ? { add: 1 } : null;
  }

  protected step(state: State, ctx: MatchContext<Input>) {
    for (const [id, input] of ctx.inputs) state.scores[id] = (state.scores[id] ?? 0) + input.add;
    // Inputs are edge-triggered in this game: consume them.
    ctx.inputs.clear();
    const winner = Object.entries(state.scores).find(([, score]) => score >= 10);
    return winner ? { winner: winner[0] } : undefined;
  }

  protected view(state: State) {
    return { players: Object.entries(state.scores).map(([id, score]) => ({ id, score })) };
  }

  protected onJoin(state: State, player: { id: string }) {
    state.scores[player.id] = 0;
    state.log.push(`join:${player.id}`);
  }

  protected onLeave(state: State, playerId: string) {
    delete state.scores[playerId];
  }
}

export { LobbyDirectory };

const lobby = createLobby<Env>({ rooms: 'ROOMS' });

interface Env {
  ROOMS: DurableObjectNamespace<TestRoom>;
  LOBBY: DurableObjectNamespace<LobbyDirectory>;
  SESSION_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env) {
    return (await lobby(request, env)) ?? new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
