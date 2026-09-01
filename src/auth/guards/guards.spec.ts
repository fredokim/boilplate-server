import { type ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from '../decorators/auth.decorators';
import { AccessTokenService } from '../tokens/accessToken.service';
import type { AuthenticatedRequest, AuthenticatedUser } from '../types/authenticatedUser';
import { AuthenticationGuard } from './authentication.guard';
import { PermissionGuard } from './permission.guard';

const user: AuthenticatedUser = {
  id: 'user-1',
  email: 'demo@example.com',
  name: 'Demo Maker',
  role: 'admin',
  permissions: ['dashboard:read', 'user:read'],
};

function createContext(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** A Reflector that answers one metadata key and nothing else. */
function createReflector(key: string, value: unknown): Reflector {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((requested: unknown) => (requested === key ? value : undefined));
  return reflector;
}

const config = { jwtSecret: 'a-secret-that-is-at-least-32-characters', accessTokenTtlSeconds: 900 } as AppConfig;

describe('AuthenticationGuard', () => {
  const tokens = new AccessTokenService(config);

  async function issue(): Promise<string> {
    return tokens.issue(user);
  }

  it('lets a public route through with no token', async () => {
    const guard = new AuthenticationGuard(createReflector(IS_PUBLIC_KEY, true), tokens);

    await expect(guard.canActivate(createContext({ headers: {} }))).resolves.toBe(true);
  });

  it('attaches the user from a valid bearer token', async () => {
    const guard = new AuthenticationGuard(createReflector(IS_PUBLIC_KEY, false), tokens);
    const request: Partial<AuthenticatedRequest> = { headers: { authorization: `Bearer ${await issue()}` } };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: 'user-1', permissions: ['dashboard:read', 'user:read'] });
  });

  /** RFC 7235 defines the scheme as case-insensitive, and clients do send "bearer". */
  it('accepts a lowercase scheme', async () => {
    const guard = new AuthenticationGuard(createReflector(IS_PUBLIC_KEY, false), tokens);
    const request: Partial<AuthenticatedRequest> = { headers: { authorization: `bearer ${await issue()}` } };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
  });

  it.each([
    ['no header', {}],
    ['an empty bearer', { authorization: 'Bearer ' }],
    ['the wrong scheme', { authorization: 'Basic abc' }],
    ['a garbage token', { authorization: 'Bearer not-a-jwt' }],
  ])('rejects %s with AUTH_REQUIRED', async (_label, headers) => {
    const guard = new AuthenticationGuard(createReflector(IS_PUBLIC_KEY, false), tokens);

    await expect(guard.canActivate(createContext({ headers }))).rejects.toMatchObject({
      code: ErrorCode.AUTH_REQUIRED,
    });
  });

  /**
   * A token signed with a different key must not be accepted, and the rejection
   * must look identical to any other — the client learns nothing about why.
   */
  it('rejects a token signed with another secret', async () => {
    const foreign = new AccessTokenService({ ...config, jwtSecret: 'a-completely-different-secret-value-32' } as AppConfig);
    const guard = new AuthenticationGuard(createReflector(IS_PUBLIC_KEY, false), tokens);
    const headers = { authorization: `Bearer ${await foreign.issue(user)}` };

    await expect(guard.canActivate(createContext({ headers }))).rejects.toMatchObject({
      code: ErrorCode.AUTH_REQUIRED,
    });
  });
});

describe('PermissionGuard', () => {
  it('allows a route that declares no permissions', () => {
    const guard = new PermissionGuard(createReflector(REQUIRED_PERMISSIONS_KEY, undefined));

    expect(guard.canActivate(createContext({ user }))).toBe(true);
  });

  it('allows a user holding every required permission', () => {
    const guard = new PermissionGuard(createReflector(REQUIRED_PERMISSIONS_KEY, ['dashboard:read']));

    expect(guard.canActivate(createContext({ user }))).toBe(true);
  });

  it('denies when one of several is missing, and names it', () => {
    const guard = new PermissionGuard(createReflector(REQUIRED_PERMISSIONS_KEY, ['dashboard:read', 'user:write']));

    try {
      guard.canActivate(createContext({ user }));
      throw new Error('Expected the guard to deny.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const denied = error as AppException;
      expect(denied.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(denied.code).toBe(ErrorCode.AUTH_FORBIDDEN);
      expect(denied.details).toEqual({ missingPermissions: ['user:write'] });
    }
  });

  /**
   * A route that declares permissions but was also marked public would otherwise
   * reach here with no user and read `undefined.permissions`. Refusing is the
   * safe reading of a configuration mistake.
   */
  it('refuses rather than throwing when no user was attached', () => {
    const guard = new PermissionGuard(createReflector(REQUIRED_PERMISSIONS_KEY, ['dashboard:read']));

    expect(() => guard.canActivate(createContext({}))).toThrow(AppException);
  });
});
