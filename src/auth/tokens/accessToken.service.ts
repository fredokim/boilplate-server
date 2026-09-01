import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../../config/app.config';
import type { AuthenticatedUser } from '../types/authenticatedUser';

/**
 * Claims carried in the access token.
 *
 * Permissions are embedded rather than looked up per request: that is what makes
 * the token self-contained and the auth guard a pure verification with no
 * database round trip. The cost is staleness — a permission revoked mid-session
 * stays effective until the token expires, which is why the TTL is capped at an
 * hour and defaults to fifteen minutes.
 */
type AccessTokenClaims = {
  sub: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
};

/**
 * `jsonwebtoken` directly rather than `@nestjs/jwt`.
 *
 * `@nestjs/jwt@12` ships as ESM only (`"type": "module"`, no CommonJS entry) and
 * this server compiles to CommonJS, so it cannot be required by the test runner
 * and is a liability in the build. The wrapper it provides is thin, and this
 * class was already the replaceable boundary — swapping to asymmetric keys or a
 * JWKS endpoint means rewriting this file and nothing else.
 *
 * The methods stay async even though the underlying calls are synchronous,
 * because that boundary will not be synchronous once keys are fetched remotely.
 */
@Injectable()
export class AccessTokenService {
  constructor(private readonly config: AppConfig) {}

  issue(user: AuthenticatedUser): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: [...user.permissions],
    };

    return Promise.resolve(
      jwt.sign(claims, this.config.jwtSecret, {
        expiresIn: this.config.accessTokenTtlSeconds,
        algorithm: 'HS256',
      }),
    );
  }

  /**
   * Returns the user or `null`. Callers get no detail about *why* a token failed
   * — expired, wrong signature, and malformed are the same answer to a client,
   * and the distinction is only useful to someone probing.
   */
  verify(token: string): Promise<AuthenticatedUser | null> {
    try {
      // Pinning the algorithm is not optional. Without it a token whose header
      // says `alg: none`, or one signed with the public half of an asymmetric
      // pair, is accepted — the classic JWT confusion attack.
      const claims = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] });
      return Promise.resolve(toUser(claims));
    } catch {
      return Promise.resolve(null);
    }
  }
}

/**
 * A signature only proves the payload is ours, not that it has the shape this
 * version expects. A token issued before a claim was added would otherwise reach
 * a guard as `permissions: undefined` and throw somewhere far from here.
 */
function toUser(claims: unknown): AuthenticatedUser | null {
  if (typeof claims !== 'object' || claims === null) return null;

  const { sub, email, name, role, permissions } = claims as Partial<AccessTokenClaims>;

  if (typeof sub !== 'string' || typeof email !== 'string' || typeof name !== 'string' || typeof role !== 'string') {
    return null;
  }

  if (!Array.isArray(permissions) || permissions.some((entry) => typeof entry !== 'string')) {
    return null;
  }

  return { id: sub, email, name, role, permissions };
}
