import { createLobby, DEFAULT_CONFIG, GameRoom, LobbyDirectory, type MatchContext, type PlayerInfo } from 'lobbyboi/server';
import {
  COIN_RADIUS,
  IDLE,
  KNOCK_COINS,
  MAX_COINS,
  RADIUS,
  WORLD,
  clamp,
  move,
  parseInput,
  type Coin,
  type Input,
  type Runner,
} from './game.js';

interface State {
  runners: Map<string, Runner>;
  coins: Coin[];
  nextCoin: number;
  endsAtTick: number;
}

const ROUND_LENGTHS = [30, 60, 90];

export class ArenaRoom extends GameRoom<State, Input, Env> {
  static config = {
    ...DEFAULT_CONFIG,
    maxPlayers: 8,
    tickHz: 30,
    snapshotHz: 15,
    settings: { bots: 3, custom: { roundSeconds: 60 } },
  };

  protected parseSettings(custom: Record<string, unknown>) {
    const roundSeconds = Number(custom.roundSeconds);
    if (!ROUND_LENGTHS.includes(roundSeconds)) throw new Error(`Round length must be one of ${ROUND_LENGTHS.join(', ')}s`);
    return { roundSeconds };
  }

  protected parseInput(raw: unknown) {
    return parseInput(raw);
  }

  protected createGame(ctx: MatchContext<Input>): State {
    const state: State = {
      runners: new Map(),
      coins: [],
      nextCoin: 0,
      endsAtTick: Number(ctx.settings.custom.roundSeconds ?? 60) * 30,
    };
    ctx.players.forEach((player, i) => this.spawn(state, player, i, ctx.players.length));
    while (state.coins.length < MAX_COINS) this.dropCoin(state);
    return state;
  }

  protected onJoin(state: State, player: PlayerInfo) {
    this.spawn(state, player, state.runners.size, state.runners.size + 1);
  }

  protected onLeave(state: State, playerId: string) {
    state.runners.delete(playerId);
  }

  protected step(state: State, ctx: MatchContext<Input>) {
    for (const runner of state.runners.values()) move(runner, ctx.inputs.get(runner.id) ?? IDLE, ctx.dt);

    // Dashing into someone knocks coins loose.
    const runners = [...state.runners.values()];
    for (const a of runners)
      for (const b of runners) {
        if (a === b || a.dashLeft === 0) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > RADIUS * 2) continue;
        const lost = Math.min(KNOCK_COINS, b.score);
        b.score -= lost;
        for (let i = 0; i < lost; i++) this.dropCoin(state, b.x, b.y, 70);
        b.x = clamp(b.x + a.dx * 60, RADIUS, WORLD.width - RADIUS);
        b.y = clamp(b.y + a.dy * 60, RADIUS, WORLD.height - RADIUS);
        a.dashLeft = 0;
        if (lost) ctx.emit('bonk', { by: a.id, hit: b.id, lost });
      }

    for (const runner of runners)
      state.coins = state.coins.filter((coin) => {
        if (Math.hypot(coin.x - runner.x, coin.y - runner.y) > RADIUS + COIN_RADIUS) return true;
        runner.score++;
        return false;
      });
    if (ctx.tick % 15 === 0 && state.coins.length < MAX_COINS) this.dropCoin(state);

    if (ctx.tick >= state.endsAtTick) {
      const scores = runners.map((r) => ({ id: r.id, score: r.score })).sort((a, b) => b.score - a.score);
      return { scores, winner: scores[0]?.id ?? null };
    }
  }

  protected view(state: State) {
    return {
      timeLeft: Math.max(0, Math.ceil((state.endsAtTick - (this.match?.tick ?? 0)) / 30)),
      runners: [...state.runners.values()].map(({ held: _held, ...runner }) => ({
        ...runner,
        x: Math.round(runner.x * 10) / 10,
        y: Math.round(runner.y * 10) / 10,
        vx: Math.round(runner.vx),
        vy: Math.round(runner.vy),
      })),
      coins: state.coins,
    };
  }

  /** Head for the nearest coin; dash at anyone carrying more than us. */
  protected botInput(state: State, botId: string): Input {
    const me = state.runners.get(botId);
    if (!me) return IDLE;
    let target: { x: number; y: number } | null = null;
    let best = Infinity;
    for (const coin of state.coins) {
      const d = Math.hypot(coin.x - me.x, coin.y - me.y);
      if (d < best) [best, target] = [d, coin];
    }
    let dash = false;
    for (const other of state.runners.values()) {
      if (other.id === me.id || other.score <= me.score) continue;
      const d = Math.hypot(other.x - me.x, other.y - me.y);
      if (d < 140 && me.cooldown === 0) {
        [target, dash] = [other, true];
        break;
      }
    }
    if (!target) return IDLE;
    // A little wobble so bots don't move like laser beams.
    const wobble = Math.sin(Date.now() / 300 + botId.length) * 0.25;
    const angle = Math.atan2(target.y - me.y, target.x - me.x) + wobble;
    return { x: Math.cos(angle), y: Math.sin(angle), dash: dash && !me.held };
  }

  private spawn(state: State, player: PlayerInfo, index: number, total: number) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2;
    state.runners.set(player.id, {
      id: player.id,
      x: WORLD.width / 2 + Math.cos(angle) * 280,
      y: WORLD.height / 2 + Math.sin(angle) * 220,
      vx: 0,
      vy: 0,
      score: 0,
      dashLeft: 0,
      cooldown: 0,
      dx: 1,
      dy: 0,
    });
  }

  private dropCoin(state: State, x?: number, y?: number, spread = 0) {
    const margin = 40;
    state.coins.push({
      id: `c${state.nextCoin++}`,
      x: x === undefined ? margin + Math.random() * (WORLD.width - margin * 2) : clamp(x + (Math.random() - 0.5) * spread * 2, margin, WORLD.width - margin),
      y: y === undefined ? margin + Math.random() * (WORLD.height - margin * 2) : clamp(y + (Math.random() - 0.5) * spread * 2, margin, WORLD.height - margin),
    });
  }
}

export { LobbyDirectory };

interface Env {
  ASSETS: Fetcher;
  ARENA: DurableObjectNamespace<ArenaRoom>;
  LOBBY: DurableObjectNamespace<LobbyDirectory>;
  SESSION_SECRET: string;
}

const lobby = createLobby<Env>({ rooms: 'ARENA' });

export default {
  async fetch(request, env) {
    return (await lobby(request, env)) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
