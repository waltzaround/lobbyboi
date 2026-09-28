// 29 characters with no 0/O, 1/I/L or U/V lookalikes, so codes survive being read aloud.
// 29^5 is about 20 million codes; creation retries on collision anyway.
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

export function roomCode(length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export const ROOM_CODE = /^[A-Z0-9]{3,12}$/;

export const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });

export const error = (code: string, message: string, status = 400) => json({ error: code, message }, status);

export async function readBody<T = Record<string, unknown>>(request: Request, limit = 8192): Promise<T> {
  const text = await request.text();
  if (text.length > limit) throw new RangeError('Request body too large');
  return (text ? JSON.parse(text) : {}) as T;
}

/** Run async work one at a time, in order. A rejected task does not block the next. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** Token bucket. `take()` returns false once the connection is over budget. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(
    private perSecond: number,
    private burst = perSecond * 2,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
