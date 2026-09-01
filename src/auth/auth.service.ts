import { HttpStatus } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/contracts/errorCode';
import { AppException } from '../common/exceptions/appException';
import { LOGGER, type LoggerPort } from '../common/logging/logger.port';
import { PrismaService } from '../database/prisma.service';
import type { AuthUserResponseDto } from './dto/auth.dto';
import { PASSWORD_HASHER, type PasswordHasher } from './password/passwordHasher.port';
import { LOGIN_ATTEMPTS, type LoginAttempts } from './rateLimit/loginAttempts.port';
import { type IssuedRefreshToken, type RefreshContext, RefreshSessionService } from './session/refreshSession.service';
import { AccessTokenService } from './tokens/accessToken.service';
import type { AuthenticatedUser } from './types/authenticatedUser';

export type AuthResult = {
  accessToken: string;
  refresh: IssuedRefreshToken;
  user: AuthUserResponseDto;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: RefreshSessionService,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(LOGIN_ATTEMPTS) private readonly attempts: LoginAttempts,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {}

  async login(email: string, password: string, context: RefreshContext): Promise<AuthResult> {
    const throttleKey = `${email}|${context.ipAddress ?? 'unknown'}`;

    if (await this.attempts.isBlocked(throttleKey)) {
      throw new AppException({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.TOO_MANY_REQUESTS,
        message: 'Too many sign-in attempts. Try again later.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
      omit: { passwordHash: false },
    });

    /**
     * The password is verified even when no account matched, against a hash that
     * cannot succeed. Returning early would make a miss measurably faster than a
     * wrong password, and that timing difference is enough to enumerate which
     * addresses have accounts.
     */
    const storedHash = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await this.passwords.verify(storedHash, password);

    if (!user || !passwordMatches) {
      await this.attempts.recordFailure(throttleKey);
      this.logger.warn('login_failed', { email, reason: user ? 'bad_password' : 'unknown_account' });

      // One code and one message for both cases, so the response cannot be used
      // to tell "no such account" from "wrong password".
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCode.AUTH_INVALID_CREDENTIALS,
        message: 'Email or password is incorrect.',
      });
    }

    if (!user.isActive) {
      // Only reported once the password was right — otherwise this is itself an
      // account-existence oracle.
      await this.attempts.recordFailure(throttleKey);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCode.AUTH_ACCOUNT_DISABLED,
        message: 'This account has been disabled.',
      });
    }

    await this.attempts.clear(throttleKey);

    // Login is the only moment the plaintext exists, so it is the only chance to
    // upgrade a hash written under weaker parameters.
    if (this.passwords.needsRehash(user.passwordHash)) {
      const upgraded = await this.passwords.hash(password);
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
      this.logger.info('password_hash_upgraded', { userId: user.id });
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const authenticated = toAuthenticatedUser(user.id, user.email, user.name, user.role.name, user.role.permissions);
    this.logger.info('login_succeeded', { userId: user.id });

    return {
      accessToken: await this.accessTokens.issue(authenticated),
      refresh: await this.sessions.startFamily(user.id, context),
      user: toResponseUser(authenticated),
    };
  }

  async refresh(token: string, context: RefreshContext): Promise<AuthResult> {
    const outcome = await this.sessions.rotate(token, context);

    if (outcome.kind === 'invalid') {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCode.AUTH_REQUIRED,
        message: 'Session could not be refreshed. Sign in again.',
      });
    }

    if (outcome.kind === 'reused') {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCode.AUTH_SESSION_REVOKED,
        message: 'This session has been revoked. Sign in again.',
      });
    }

    const user = await this.loadActiveUser(outcome.userId);
    return {
      accessToken: await this.accessTokens.issue(user),
      refresh: outcome.issued,
      user: toResponseUser(user),
    };
  }

  /** Idempotent: a stale or absent cookie is not an error. */
  async logout(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    return this.sessions.revokeByToken(token);
  }

  /**
   * Reads the current user from the database rather than echoing the token
   * claims. A role change or a disabled account takes effect here immediately,
   * which is what makes this endpoint worth calling at all.
   */
  async session(userId: string): Promise<AuthUserResponseDto> {
    return toResponseUser(await this.loadActiveUser(userId));
  }

  private async loadActiveUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });

    if (!user) {
      // The token verified, so this is a user deleted mid-session.
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCode.AUTH_REQUIRED,
        message: 'Session is no longer valid.',
      });
    }

    if (!user.isActive) {
      await this.sessions.revokeAllForUser(user.id);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCode.AUTH_ACCOUNT_DISABLED,
        message: 'This account has been disabled.',
      });
    }

    return toAuthenticatedUser(user.id, user.email, user.name, user.role.name, user.role.permissions);
  }
}

/**
 * A real Argon2id hash, of 32 random bytes that were discarded — so no password
 * verifies against it, and none ever will.
 *
 * It has to be a genuine, parseable hash. An invented string would fail to parse
 * and the verifier would return false immediately, which is exactly the fast path
 * this constant exists to avoid: a miss would once again be measurably quicker
 * than a wrong password. Verified against the real adapter at ~10ms, the same
 * cost as a normal check.
 */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$3aEeaULS3G7Izikc7utsVg$rTHQdUhl82u9l5J/+YTdrVJRL1+DU57bpgeqRvRaDp4';

function toAuthenticatedUser(
  id: string,
  email: string,
  name: string,
  role: string,
  permissions: string[],
): AuthenticatedUser {
  return { id, email, name, role, permissions };
}

function toResponseUser(user: AuthenticatedUser): AuthUserResponseDto {
  // Only the four fields the frontend's AuthUserDto declares. Role is carried on
  // the token for guards but is not part of the response contract.
  return { id: user.id, email: user.email, name: user.name, permissions: [...user.permissions] };
}
