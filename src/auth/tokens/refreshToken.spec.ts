import { generateRefreshToken, hashRefreshToken, refreshTokenHashEquals } from './refreshToken';

describe('refresh tokens', () => {
  it('generates a distinct token every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRefreshToken()));

    expect(tokens.size).toBe(100);
  });

  it('generates 256 bits of entropy', () => {
    // base64url of 32 bytes, unpadded.
    expect(Buffer.from(generateRefreshToken(), 'base64url')).toHaveLength(32);
  });

  it('hashes deterministically so a lookup by hash finds the row', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('does not leak the token through its hash', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);

    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });

  describe('refreshTokenHashEquals', () => {
    it('matches identical digests', () => {
      const hash = hashRefreshToken('token');

      expect(refreshTokenHashEquals(hash, hash)).toBe(true);
    });

    it('rejects different digests', () => {
      expect(refreshTokenHashEquals(hashRefreshToken('a'), hashRefreshToken('b'))).toBe(false);
    });

    /** timingSafeEqual throws on a length mismatch; the guard must absorb that. */
    it('rejects a malformed digest without throwing', () => {
      expect(() => refreshTokenHashEquals(hashRefreshToken('a'), 'abc')).not.toThrow();
      expect(refreshTokenHashEquals(hashRefreshToken('a'), 'abc')).toBe(false);
    });
  });
});
