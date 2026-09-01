import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of entropy. Guessing is not a threat model at this size. */
const TOKEN_BYTES = 32;

export function generateRefreshToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256, not Argon2 — and that is not an oversight.
 *
 * Argon2's cost exists to make guessing a *low-entropy* secret expensive. A
 * refresh token is 256 random bits, so there is nothing to guess: the only way to
 * use one is to have stolen it. What the hash must do is ensure a leaked database
 * does not hand over working tokens, and a fast one-way function does that
 * completely. Using Argon2 here would add hundreds of milliseconds to every
 * refresh and to every lookup, for no gain.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Lookups go through the unique `tokenHash` column, so this is not on the main
 * path; it exists for the places where two hashes are compared in memory, where
 * `===` would leak the position of the first differing byte through timing.
 */
export function refreshTokenHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');

  // timingSafeEqual throws on length mismatch, which is itself a length oracle —
  // but lengths are fixed by the digest, so a mismatch means malformed input.
  return a.length === b.length && timingSafeEqual(a, b);
}
