// Signed guest sessions. The Worker issues an HMAC-signed token, stores it in
// an HttpOnly cookie and passes the verified identity to rooms in a header, so
// a room never has to trust anything the client says about who it is.

export interface Identity {
  id: string;
  name: string;
  expiresAt: number;
}

export const SESSION_COOKIE = 'lobbyboi';
export const SESSION_HEADER = 'X-Lobbyboi-Session';
const WEEK_MS = 7 * 86_400_000;
const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const unb64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();
const key = (secret: string) => {
  let cached = keys.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keys.set(secret, cached);
  }
  return cached;
};

/** Strip a display name down to something safe to render anywhere. */
export function cleanName(name: unknown, fallback = 'Player'): string {
  if (typeof name !== 'string') return fallback;
  return name.replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20) || fallback;
}

export async function signSession(identity: Identity, secret: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(identity)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload)));
  return `${payload}.${b64url(signature)}`;
}

export async function verifySession(token: string | null | undefined, secret: string): Promise<Identity | null> {
  if (!token) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra !== undefined || !payload || !signature) return null;
    const valid = await crypto.subtle.verify('HMAC', await key(secret), unb64url(signature), encoder.encode(payload));
    if (!valid) return null;
    const identity = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Identity;
    return typeof identity.id === 'string' && typeof identity.name === 'string' && identity.expiresAt > Date.now()
      ? identity
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the session from the cookie, the session header, or a `?session=` query
 * parameter (browsers can't set headers on WebSocket upgrades, and some embeds
 * block third-party cookies).
 */
export function readToken(request: Request): string | null {
  const header = request.headers.get(SESSION_HEADER);
  if (header) return header;
  const query = new URL(request.url).searchParams.get('session');
  if (query) return query;
  const cookie = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : null;
}

export async function readSession(request: Request, secret: string) {
  return verifySession(readToken(request), secret);
}

/** Issue or refresh a session, keeping the existing id when there is one. */
export async function issueSession(request: Request, secret: string, name: unknown) {
  const previous = await readSession(request, secret);
  const identity: Identity = {
    id: previous?.id ?? crypto.randomUUID(),
    name: name === undefined && previous ? previous.name : cleanName(name),
    expiresAt: Date.now() + WEEK_MS,
  };
  const token = await signSession(identity, secret);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return Response.json(
    { id: identity.id, name: identity.name, token },
    {
      headers: {
        'cache-control': 'no-store',
        'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${WEEK_MS / 1000}${secure}`,
      },
    },
  );
}
