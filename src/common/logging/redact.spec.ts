import { REDACTED, redactHeaders, redactValue } from './redact';

describe('redactHeaders', () => {
  it('removes credential-bearing headers and keeps the rest', () => {
    const safe = redactHeaders({
      authorization: 'Bearer secret-token',
      cookie: 'session=abc',
      'content-type': 'application/json',
    });

    expect(safe).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'content-type': 'application/json',
    });
  });

  it('matches header names case-insensitively', () => {
    expect(redactHeaders({ Authorization: 'Bearer x' })).toEqual({ Authorization: REDACTED });
  });

  it('does not mutate the original headers', () => {
    const original = { authorization: 'Bearer secret-token' };
    redactHeaders(original);

    expect(original.authorization).toBe('Bearer secret-token');
  });
});

describe('redactValue', () => {
  it('redacts sensitive fields at any depth', () => {
    const safe = redactValue({ user: { email: 'a@b.com', password: 'hunter2' } });

    expect(safe).toEqual({ user: { email: 'a@b.com', password: REDACTED } });
  });

  it('matches field names regardless of casing or separators', () => {
    const safe = redactValue({ access_token: 'x', 'refresh-token': 'y', ApiKey: 'z' });

    expect(safe).toEqual({ access_token: REDACTED, 'refresh-token': REDACTED, ApiKey: REDACTED });
  });

  it('stops descending before a cyclic structure can hang the logger', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    expect(() => JSON.stringify(redactValue(cyclic))).not.toThrow();
  });

  it('passes primitives through untouched', () => {
    expect(redactValue('plain')).toBe('plain');
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
  });
});
