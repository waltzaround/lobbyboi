import { describe, expect, it } from 'vitest';
import { Interpolator, lerpAngle } from '../src/client/interpolation.js';
import { RateLimiter, roomCode } from '../src/server/util.js';
import { DeltaDecoder, DeltaEncoder } from '../src/shared/delta.js';

describe('delta codec', () => {
  // Deterministic PRNG so failures reproduce.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  function randomState(random: () => number, tick: number) {
    const count = Math.floor(random() * 6);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].filter(() => random() > 0.3).slice(0, count);
    if (random() > 0.5) ids.reverse();
    const state: Record<string, unknown> = {
      tick,
      players: ids.map((id) => ({
        id,
        x: Math.round(random() * 10),
        y: Math.round(random() * 10),
        ...(random() > 0.7 ? { shield: true } : {}),
      })),
    };
    if (random() > 0.6) state.message = `m${Math.floor(random() * 3)}`;
    if (random() > 0.8) state.bullets = [];
    else if (random() > 0.5) state.bullets = [{ id: 'z', x: random() }];
    return state;
  }

  it('round-trips random state sequences exactly', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed);
      const encoder = new DeltaEncoder(25);
      const decoder = new DeltaDecoder();
      for (let tick = 0; tick < 120; tick++) {
        const state = randomState(random, tick);
        const out = encoder.encode(state);
        const decoded =
          out.kind === 'full' ? decoder.full(out.frame, out.state) : decoder.apply(out.frame, out.base, out.patch);
        expect(decoded, `seed ${seed} tick ${tick}`).toEqual(state);
      }
    }
  });

  it('sends only what changed', () => {
    const encoder = new DeltaEncoder();
    const players = [
      { id: 'a', x: 0, y: 0, name: 'Alice', colour: '#f00' },
      { id: 'b', x: 5, y: 5, name: 'Bob', colour: '#00f' },
    ];
    encoder.encode({ players, score: 1 });
    const out = encoder.encode({ players: [{ ...players[0]!, x: 1 }, players[1]], score: 1 });
    expect(out).toMatchObject({ kind: 'delta', patch: { lists: { players: { upserts: [{ id: 'a', set: { x: 1 } }] } } } });
    expect(out.kind === 'delta' && out.patch.set).toBeFalsy();
    expect(out.kind === 'delta' && out.patch.lists!.players!.order).toBeUndefined();
  });

  it('refuses deltas after a gap so the client can resync', () => {
    const encoder = new DeltaEncoder();
    const decoder = new DeltaDecoder();
    const first = encoder.encode({ players: [{ id: 'a', x: 0, name: 'long enough to be worth a delta' }] });
    decoder.full(first.frame, first.kind === 'full' ? first.state : {});
    encoder.encode({ players: [{ id: 'a', x: 1, name: 'long enough to be worth a delta' }] }); // lost
    const third = encoder.encode({ players: [{ id: 'a', x: 2, name: 'long enough to be worth a delta' }] });
    expect(third.kind).toBe('delta');
    if (third.kind === 'delta') expect(decoder.apply(third.frame, third.base, third.patch)).toBeNull();
  });

  it('emits keyframes on schedule', () => {
    const encoder = new DeltaEncoder(10);
    const kinds = Array.from({ length: 25 }, (_, i) =>
      encoder.encode({ players: [{ id: 'a', x: i, name: 'a reasonably long name' }] }).kind,
    );
    expect(kinds.map((k, i) => (k === 'full' ? i : -1)).filter((i) => i >= 0)).toEqual([0, 10, 20]);
  });
});

describe('Interpolator', () => {
  it('interpolates between snapshots around the render time', () => {
    const buffer = new Interpolator<{ id: string; x: number; y: number }>({ delayMs: 100 });
    buffer.push(1000, [{ id: 'a', x: 0, y: 0 }]);
    buffer.push(1100, [{ id: 'a', x: 10, y: 20 }]);
    expect(buffer.sample(1150)).toEqual([{ id: 'a', x: 5, y: 10 }]);
    expect(buffer.sample(1100)).toEqual([{ id: 'a', x: 0, y: 0 }]);
  });

  it('extrapolates along velocity for a limited time, then holds', () => {
    const buffer = new Interpolator<{ id: string; x: number; vx: number }>({ delayMs: 0, maxExtrapolateMs: 100 });
    buffer.push(1000, [{ id: 'a', x: 0, vx: 10 }]);
    expect(buffer.sample(1050)[0]!.x).toBeCloseTo(0.5);
    expect(buffer.sample(5000)[0]!.x).toBeCloseTo(1);
  });

  it('skips your own entity and drops out-of-order snapshots', () => {
    const buffer = new Interpolator<{ id: string; x: number }>({ delayMs: 0 });
    buffer.push(1000, [{ id: 'me', x: 0 }, { id: 'you', x: 0 }]);
    buffer.push(900, [{ id: 'you', x: 99 }]);
    expect(buffer.sample(1000, 'me')).toEqual([{ id: 'you', x: 0 }]);
  });

  it('turns angles the short way round', () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills over time', () => {
    const limiter = new RateLimiter(10, 20, 0);
    let allowed = 0;
    for (let i = 0; i < 50; i++) if (limiter.take(0)) allowed++;
    expect(allowed).toBe(20);
    expect(limiter.take(0)).toBe(false);
    expect(limiter.take(100)).toBe(true);
    expect(limiter.take(100)).toBe(false);
  });
});

describe('roomCode', () => {
  it('avoids lookalike characters', () => {
    const codes = Array.from({ length: 500 }, () => roomCode()).join('');
    expect(codes).toMatch(/^[A-Z2-9]+$/);
    expect(codes).not.toMatch(/[01ILOUV]/);
  });
});
