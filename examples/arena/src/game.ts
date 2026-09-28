// Coin Rush rules, shared by the server (authoritative) and the client
// (predicting your own movement with the exact same code).

export const WORLD = { width: 1200, height: 800 };
export const RADIUS = 18;
export const SPEED = 260;
export const DASH_SPEED = 760;
export const DASH_MS = 160;
export const DASH_COOLDOWN_MS = 1400;
export const COIN_RADIUS = 9;
export const MAX_COINS = 14;
export const KNOCK_COINS = 3;

export interface Input {
  /** Movement direction, each axis in [-1, 1]. */
  x: number;
  y: number;
  dash: boolean;
}

export interface Runner {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  score: number;
  /** Dash is active while dashLeft > 0 (ms). */
  dashLeft: number;
  cooldown: number;
  /** Direction of the current dash. */
  dx: number;
  dy: number;
  /** Server-only: whether dash was held last tick, for edge detection. */
  held?: boolean;
}

export interface Coin {
  id: string;
  x: number;
  y: number;
}

export const IDLE: Input = { x: 0, y: 0, dash: false };

export function parseInput(raw: unknown): Input | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, dash } = raw as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x, -1, 1), y: clamp(y, -1, 1), dash: dash === true };
}

/** Advance one runner by `dt` seconds. Pure movement: no coins, no collisions with others. */
export function move(runner: Runner, input: Input, dt: number) {
  const ms = dt * 1000;
  runner.cooldown = Math.max(0, runner.cooldown - ms);
  const length = Math.hypot(input.x, input.y);
  const nx = length > 1 ? input.x / length : input.x;
  const ny = length > 1 ? input.y / length : input.y;

  if (input.dash && !runner.held && runner.cooldown === 0 && runner.dashLeft === 0) {
    const facing = Math.hypot(nx, ny) > 0.1 ? Math.hypot(nx, ny) : 0;
    runner.dx = facing ? nx / facing : runner.vx ? Math.sign(runner.vx) : 1;
    runner.dy = facing ? ny / facing : 0;
    runner.dashLeft = DASH_MS;
    runner.cooldown = DASH_COOLDOWN_MS;
  }
  runner.held = input.dash;

  if (runner.dashLeft > 0) {
    runner.vx = runner.dx * DASH_SPEED;
    runner.vy = runner.dy * DASH_SPEED;
    runner.dashLeft = Math.max(0, runner.dashLeft - ms);
  } else {
    runner.vx = nx * SPEED;
    runner.vy = ny * SPEED;
  }
  runner.x = clamp(runner.x + runner.vx * dt, RADIUS, WORLD.width - RADIUS);
  runner.y = clamp(runner.y + runner.vy * dt, RADIUS, WORLD.height - RADIUS);
}

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Stable colour per player id. */
export function colourFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 80% 62%)`;
}
