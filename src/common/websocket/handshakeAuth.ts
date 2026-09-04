import type { IncomingMessage } from 'node:http';

/**
 * The access token cookie.
 *
 * This server does not set it — a client that runs its own server does, and
 * then forwards the socket handshake. The Next.js boilerplate works that way:
 * it keeps the access token in an HttpOnly cookie so the page never holds it,
 * which also means the page cannot put the token in a URL.
 */
export const ACCESS_COOKIE_NAME = 'rb_access';

function fromQuery(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token');

  return token !== null && token.length > 0 ? token : null;
}

function fromCookie(request: IncomingMessage): string | null {
  const header = request.headers.cookie;

  if (header === undefined) return null;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');

    if (name !== ACCESS_COOKIE_NAME) continue;

    const value = rest.join('=');

    return value.length > 0 ? decodeURIComponent(value) : null;
  }

  return null;
}

export type HandshakeCredential = { token: string; fromCookie: boolean } | null;

/**
 * Reads the access token a handshake presents: the query string first, then the
 * cookie. The React and Vue boilerplates hold the token in JavaScript and use
 * the query; the Next.js one cannot, and uses the cookie.
 */
export function readHandshakeCredential(request: IncomingMessage): HandshakeCredential {
  const queryToken = fromQuery(request);

  if (queryToken !== null) return { token: queryToken, fromCookie: false };

  const cookieToken = fromCookie(request);

  if (cookieToken !== null) return { token: cookieToken, fromCookie: true };

  return null;
}

/**
 * Whether a cookie-authenticated handshake came from a page allowed to make it.
 *
 * A WebSocket handshake is not subject to CORS, and the browser attaches
 * cookies to it whatever page opened it. So treating a cookie as proof of
 * identity opens cross-site WebSocket hijacking unless the origin is checked:
 * any site could open a socket here and be authenticated as whoever is signed
 * in. A query token carries no such risk, because a hostile page has no way to
 * read one — which is why this is enforced only for the cookie path.
 */
export function isTrustedOrigin(request: IncomingMessage, allowed: readonly string[]): boolean {
  const origin = request.headers.origin;

  return origin !== undefined && allowed.includes(origin);
}
