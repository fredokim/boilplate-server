import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/appException';
import { ErrorCode } from '../common/contracts/errorCode';
import type { PrismaService } from '../database/prisma.service';
import { AuthService } from './auth.service';
import type { RefreshOutcome, RefreshSessionService } from './session/refreshSession.service';
import type { AccessTokenService } from './tokens/accessToken.service';

/**
 * The service is tested against stubs rather than a database. Every rule under
 * test — which failures are indistinguishable, when the account state is checked,
 * what a reused token does — is a decision made in this file, not in PostgreSQL.
 */

type Stubs = ReturnType<typeof createStubs>;

const adminRole = { name: 'admin', permissions: ['dashboard:read', 'user:write'] };

const activeUser = {
  id: 'user-1',
  email: 'demo@example.com',
  name: 'Demo Maker',
  passwordHash: 'stored-hash',
  isActive: true,
  role: adminRole,
};

function createStubs() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(activeUser),
      update: jest.fn().mockResolvedValue(activeUser),
    },
  };

  const accessTokens = { issue: jest.fn().mockResolvedValue('issued-access-token') };

  const sessions = {
    startFamily: jest.fn().mockResolvedValue({ token: 'refresh-1', expiresAt: new Date() }),
    rotate: jest.fn(),
    revokeByToken: jest.fn().mockResolvedValue(true),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };

  const passwords = {
    hash: jest.fn().mockResolvedValue('new-hash'),
    verify: jest.fn().mockResolvedValue(true),
    needsRehash: jest.fn().mockReturnValue(false),
  };

  const attempts = {
    isBlocked: jest.fn().mockResolvedValue(false),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };

  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  return { prisma, accessTokens, sessions, passwords, attempts, logger };
}

function createService(stubs: Stubs): AuthService {
  return new AuthService(
    stubs.prisma as unknown as PrismaService,
    stubs.accessTokens as unknown as AccessTokenService,
    stubs.sessions as unknown as RefreshSessionService,
    stubs.passwords,
    stubs.attempts,
    stubs.logger,
  );
}

const context = { userAgent: 'jest', ipAddress: '127.0.0.1' };

async function expectAppException(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    return error as AppException;
  }

  throw new Error('Expected the call to reject.');
}

describe('AuthService', () => {
  describe('login', () => {
    it('returns an access token, a refresh token, and the frontend user shape', async () => {
      const stubs = createStubs();
      const result = await createService(stubs).login('demo@example.com', 'password123', context);

      expect(result.accessToken).toBe('issued-access-token');
      expect(result.refresh.token).toBe('refresh-1');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'demo@example.com',
        name: 'Demo Maker',
        permissions: ['dashboard:read', 'user:write'],
      });
    });

    it('never puts the password hash or the role in the response', async () => {
      const stubs = createStubs();
      const result = await createService(stubs).login('demo@example.com', 'password123', context);

      expect(Object.keys(result.user).sort()).toEqual(['email', 'id', 'name', 'permissions']);
      expect(JSON.stringify(result.user)).not.toContain('stored-hash');
    });

    /**
     * The central rule of this endpoint. If these two answers differed in code,
     * message, or status, the login form would report whether an address has an
     * account.
     */
    it('answers identically for an unknown account and a wrong password', async () => {
      const unknownAccount = createStubs();
      unknownAccount.prisma.user.findUnique.mockResolvedValue(null);
      unknownAccount.passwords.verify.mockResolvedValue(false);

      const wrongPassword = createStubs();
      wrongPassword.passwords.verify.mockResolvedValue(false);

      const first = await expectAppException(createService(unknownAccount).login('nobody@example.com', 'pw', context));
      const second = await expectAppException(createService(wrongPassword).login('demo@example.com', 'pw', context));

      expect(first.code).toBe(second.code);
      expect(first.message).toBe(second.message);
      expect(first.getStatus()).toBe(second.getStatus());
      expect(first.code).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
    });

    /**
     * The timing half of the same rule: an unknown address must still pay for a
     * hash verification, or the response time answers the question the status
     * code refuses to.
     */
    it('still verifies a password when no account matched', async () => {
      const stubs = createStubs();
      stubs.prisma.user.findUnique.mockResolvedValue(null);
      stubs.passwords.verify.mockResolvedValue(false);

      await expectAppException(createService(stubs).login('nobody@example.com', 'pw', context));

      expect(stubs.passwords.verify).toHaveBeenCalledTimes(1);
    });

    it('reports a disabled account only after the password was correct', async () => {
      const stubs = createStubs();
      stubs.prisma.user.findUnique.mockResolvedValue({ ...activeUser, isActive: false });

      const error = await expectAppException(createService(stubs).login('demo@example.com', 'password123', context));

      expect(error.code).toBe(ErrorCode.AUTH_ACCOUNT_DISABLED);
      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(stubs.passwords.verify).toHaveBeenCalled();
    });

    it('refuses outright once the attempt budget is spent', async () => {
      const stubs = createStubs();
      stubs.attempts.isBlocked.mockResolvedValue(true);

      const error = await expectAppException(createService(stubs).login('demo@example.com', 'password123', context));

      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // Nothing is looked up or verified for a blocked key.
      expect(stubs.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(stubs.passwords.verify).not.toHaveBeenCalled();
    });

    it('counts a failure and clears the count on success', async () => {
      const failing = createStubs();
      failing.passwords.verify.mockResolvedValue(false);
      await expectAppException(createService(failing).login('demo@example.com', 'pw', context));
      expect(failing.attempts.recordFailure).toHaveBeenCalledTimes(1);

      const succeeding = createStubs();
      await createService(succeeding).login('demo@example.com', 'password123', context);
      expect(succeeding.attempts.clear).toHaveBeenCalledTimes(1);
      expect(succeeding.attempts.recordFailure).not.toHaveBeenCalled();
    });

    it('upgrades a hash written under weaker parameters', async () => {
      const stubs = createStubs();
      stubs.passwords.needsRehash.mockReturnValue(true);

      await createService(stubs).login('demo@example.com', 'password123', context);

      expect(stubs.passwords.hash).toHaveBeenCalledWith('password123');
      expect(stubs.prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { passwordHash: 'new-hash' } }),
      );
    });

    it('leaves a current hash alone', async () => {
      const stubs = createStubs();
      await createService(stubs).login('demo@example.com', 'password123', context);

      expect(stubs.passwords.hash).not.toHaveBeenCalled();
    });

    it('does not log the password', async () => {
      const stubs = createStubs();
      stubs.passwords.verify.mockResolvedValue(false);

      await expectAppException(createService(stubs).login('demo@example.com', 'hunter2', context));

      expect(JSON.stringify(stubs.logger.warn.mock.calls)).not.toContain('hunter2');
    });
  });

  describe('refresh', () => {
    it('issues a new access token when the session rotates', async () => {
      const stubs = createStubs();
      const rotated: RefreshOutcome = {
        kind: 'rotated',
        userId: 'user-1',
        issued: { token: 'refresh-2', expiresAt: new Date() },
      };
      stubs.sessions.rotate.mockResolvedValue(rotated);

      const result = await createService(stubs).refresh('refresh-1', context);

      expect(result.accessToken).toBe('issued-access-token');
      expect(result.refresh.token).toBe('refresh-2');
    });

    /**
     * A replayed token is not the same event as an expired one, and the codes
     * differ so a client can tell "sign in again" from "your session was ended
     * because something went wrong".
     */
    it('reports a reused token as a revoked session', async () => {
      const stubs = createStubs();
      stubs.sessions.rotate.mockResolvedValue({ kind: 'reused', userId: 'user-1' } satisfies RefreshOutcome);

      const error = await expectAppException(createService(stubs).refresh('refresh-1', context));

      expect(error.code).toBe(ErrorCode.AUTH_SESSION_REVOKED);
      expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('reports an unknown or expired token as needing authentication', async () => {
      const stubs = createStubs();
      stubs.sessions.rotate.mockResolvedValue({ kind: 'invalid' } satisfies RefreshOutcome);

      const error = await expectAppException(createService(stubs).refresh('whatever', context));

      expect(error.code).toBe(ErrorCode.AUTH_REQUIRED);
    });

    it('refuses to refresh into a disabled account, and ends its other sessions', async () => {
      const stubs = createStubs();
      stubs.sessions.rotate.mockResolvedValue({
        kind: 'rotated',
        userId: 'user-1',
        issued: { token: 'refresh-2', expiresAt: new Date() },
      } satisfies RefreshOutcome);
      stubs.prisma.user.findUnique.mockResolvedValue({ ...activeUser, isActive: false });

      const error = await expectAppException(createService(stubs).refresh('refresh-1', context));

      expect(error.code).toBe(ErrorCode.AUTH_ACCOUNT_DISABLED);
      expect(stubs.sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('logout', () => {
    it('revokes the presented session', async () => {
      const stubs = createStubs();

      await expect(createService(stubs).logout('refresh-1')).resolves.toBe(true);
      expect(stubs.sessions.revokeByToken).toHaveBeenCalledWith('refresh-1');
    });

    /** Logging out without a cookie is a success, not an error. */
    it('is idempotent when there is no token', async () => {
      const stubs = createStubs();

      await expect(createService(stubs).logout(undefined)).resolves.toBe(false);
      expect(stubs.sessions.revokeByToken).not.toHaveBeenCalled();
    });

    it('is idempotent when the token is already revoked', async () => {
      const stubs = createStubs();
      stubs.sessions.revokeByToken.mockResolvedValue(false);

      await expect(createService(stubs).logout('stale')).resolves.toBe(false);
    });
  });

  describe('session', () => {
    it('reads the user from the database rather than echoing token claims', async () => {
      const stubs = createStubs();
      stubs.prisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        role: { name: 'viewer', permissions: ['dashboard:read'] },
      });

      const user = await createService(stubs).session('user-1');

      expect(user.permissions).toEqual(['dashboard:read']);
      expect(stubs.prisma.user.findUnique).toHaveBeenCalled();
    });

    it('rejects a session for a user deleted mid-flight', async () => {
      const stubs = createStubs();
      stubs.prisma.user.findUnique.mockResolvedValue(null);

      const error = await expectAppException(createService(stubs).session('ghost'));

      expect(error.code).toBe(ErrorCode.AUTH_REQUIRED);
    });
  });
});
