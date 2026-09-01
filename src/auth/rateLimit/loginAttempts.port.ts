/**
 * Login attempt throttling, behind a token so the storage can be replaced.
 *
 * The in-memory implementation is correct for one process and wrong for several:
 * each instance would keep its own count, so N instances allow N times the
 * attempts. Redis is deliberately not introduced in this step — this interface is
 * the seam where it goes when horizontal scaling arrives.
 */
export interface LoginAttempts {
  /** True when the key has exceeded its budget and should be refused outright. */
  isBlocked(key: string): Promise<boolean>;
  recordFailure(key: string): Promise<void>;
  /** A successful login clears the count so a person who mistyped is not punished. */
  clear(key: string): Promise<void>;
}

export const LOGIN_ATTEMPTS = Symbol('LOGIN_ATTEMPTS');
