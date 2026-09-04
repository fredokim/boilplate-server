import type { IncomingMessage } from 'node:http';
import { ACCESS_COOKIE_NAME, isTrustedOrigin, readHandshakeCredential } from './handshakeAuth';

function handshake(options: { url?: string; cookie?: string; origin?: string } = {}): IncomingMessage {
  return {
    url: options.url ?? '/api/topology',
    headers: {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
  } as unknown as IncomingMessage;
}

describe('readHandshakeCredential', () => {
  it('prefers the query token, and does not require a trusted origin for it', () => {
    const credential = readHandshakeCredential(handshake({ url: '/api/topology?token=abc' }));

    expect(credential).toEqual({ token: 'abc', fromCookie: false });
  });

  it('falls back to the access cookie', () => {
    const credential = readHandshakeCredential(handshake({ cookie: `${ACCESS_COOKIE_NAME}=xyz` }));

    expect(credential).toEqual({ token: 'xyz', fromCookie: true });
  });

  it('finds the cookie among others', () => {
    const credential = readHandshakeCredential(
      handshake({ cookie: `other=1; ${ACCESS_COOKIE_NAME}=xyz; another=2` }),
    );

    expect(credential?.token).toBe('xyz');
  });

  /** A JWT contains dots but no equals; a percent-encoded value still must decode. */
  it('decodes a percent-encoded cookie value', () => {
    const credential = readHandshakeCredential(
      handshake({ cookie: `${ACCESS_COOKIE_NAME}=${encodeURIComponent('a b')}` }),
    );

    expect(credential?.token).toBe('a b');
  });

  it('reports nothing when neither source carries a token', () => {
    expect(readHandshakeCredential(handshake())).toBeNull();
    expect(readHandshakeCredential(handshake({ cookie: 'unrelated=1' }))).toBeNull();
    expect(readHandshakeCredential(handshake({ url: '/api/topology?token=' }))).toBeNull();
  });
});

describe('isTrustedOrigin', () => {
  const allowed = ['http://localhost:3000'];

  it('accepts an allowed origin', () => {
    expect(isTrustedOrigin(handshake({ origin: 'http://localhost:3000' }), allowed)).toBe(true);
  });

  /**
   * The case the check exists for. A WebSocket handshake is not subject to
   * CORS and carries cookies whatever page opened it, so without this an
   * attacker's page could open a socket and be authenticated as the signed-in
   * user.
   */
  it('rejects another site', () => {
    expect(isTrustedOrigin(handshake({ origin: 'https://evil.example' }), allowed)).toBe(false);
  });

  it('rejects a handshake with no origin at all', () => {
    expect(isTrustedOrigin(handshake(), allowed)).toBe(false);
  });
});
