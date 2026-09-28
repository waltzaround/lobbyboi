// Turns 10–30 Hz snapshots into smooth 60+ fps motion.
//
// Remote entities are drawn `delayMs` in the past and interpolated between
// the two snapshots around that moment, so uneven packet arrival never shows
// up as stutter. When the buffer runs dry, entities are extrapolated along
// their velocity for up to `maxExtrapolateMs`, then held.
//
// Your own player should usually be predicted from local input instead; see
// the arena example for prediction with server reconciliation.

export interface Entity {
  id: string;
}

export interface InterpolationOptions {
  /** How far behind the server clock to render. ~2 snapshot intervals is a good start. */
  delayMs?: number;
  /** Snapshots to keep. */
  capacity?: number;
  /** Extrapolation limit once the buffer runs out. */
  maxExtrapolateMs?: number;
  /** Numeric fields to interpolate linearly. Default x, y, z. */
  fields?: string[];
  /** Fields that are angles in radians, interpolated the short way round. */
  angles?: string[];
  /** Velocity fields matching `fields`, for extrapolation. Default vx, vy, vz. */
  velocities?: string[];
}

interface Frame<T extends Entity> {
  time: number;
  entities: Map<string, T>;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Interpolator<T extends Entity> {
  private frames: Frame<T>[] = [];
  private readonly delayMs: number;
  private readonly capacity: number;
  private readonly maxExtrapolateMs: number;
  private readonly fields: string[];
  private readonly angles: string[];
  private readonly velocities: string[];

  constructor(options: InterpolationOptions = {}) {
    this.delayMs = options.delayMs ?? 100;
    this.capacity = options.capacity ?? 20;
    this.maxExtrapolateMs = options.maxExtrapolateMs ?? 120;
    this.fields = options.fields ?? ['x', 'y', 'z'];
    this.angles = options.angles ?? [];
    this.velocities = options.velocities ?? ['vx', 'vy', 'vz'];
  }

  /** Add a snapshot's entities, stamped with the snapshot's server time. */
  push(time: number, entities: readonly T[]) {
    const last = this.frames[this.frames.length - 1];
    if (last && time <= last.time) {
      // A big jump back means a new match or a reconnect: start over.
      if (time < last.time - 1000) this.clear();
      else return;
    }
    this.frames.push({ time, entities: new Map(entities.map((e) => [e.id, e])) });
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  clear() {
    this.frames.length = 0;
  }

  /**
   * Entities as they were at `serverNow - delayMs`. Pass the connection's
   * `serverTime()`. Entities in `skip` (your own player) are left out.
   */
  sample(serverNow: number, skip?: string): T[] {
    const frames = this.frames;
    if (!frames.length) return [];
    const renderAt = serverNow - this.delayMs;

    let a = frames[0]!;
    let b: Frame<T> | null = null;
    for (const frame of frames) {
      if (frame.time <= renderAt) a = frame;
      else {
        b = frame;
        break;
      }
    }
    let alpha = 0;
    let extra = 0;
    if (b && renderAt >= a.time) alpha = (renderAt - a.time) / (b.time - a.time);
    else if (!b) extra = Math.min(this.maxExtrapolateMs, Math.max(0, renderAt - a.time)) / 1000;
    const to = b && renderAt >= a.time ? b : a;

    const out: T[] = [];
    for (const [id, next] of to.entities) {
      if (id === skip) continue;
      const prev = (a.entities.get(id) ?? next) as unknown as Record<string, unknown>;
      const now = next as unknown as Record<string, unknown>;
      const blended: Record<string, unknown> = { ...now };
      this.fields.forEach((field, i) => {
        const p = prev[field];
        const n = now[field];
        if (typeof p !== 'number' || typeof n !== 'number') return;
        const v = now[this.velocities[i] ?? ''];
        blended[field] = lerp(p, n, alpha) + (typeof v === 'number' ? v * extra : 0);
      });
      for (const field of this.angles) {
        const p = prev[field];
        const n = now[field];
        if (typeof p === 'number' && typeof n === 'number') blended[field] = lerpAngle(p, n, alpha);
      }
      out.push(blended as unknown as T);
    }
    return out;
  }

  /** The newest copy of an entity, e.g. your own player for reconciliation. */
  latest(id: string): T | undefined {
    return this.frames[this.frames.length - 1]?.entities.get(id);
  }
}
