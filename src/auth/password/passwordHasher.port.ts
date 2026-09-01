/**
 * Password hashing behind a token, so the algorithm can be replaced without
 * touching `AuthService`.
 *
 * `needsRehash` exists because parameters get raised over time: when the cost
 * settings change, existing hashes are still valid but weaker than the current
 * policy. Login is the only moment the plaintext is available, so it is the only
 * moment an upgrade is possible.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
