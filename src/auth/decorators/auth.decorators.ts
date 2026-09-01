import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { type AuthenticatedUser, getAuthenticatedUser } from '../types/authenticatedUser';

export const IS_PUBLIC_KEY = 'auth:public';
export const REQUIRED_PERMISSIONS_KEY = 'auth:permissions';

/**
 * Opts a route out of the global authentication guard.
 *
 * The guard is applied to everything by default, so a new controller is protected
 * the moment it is written. Exposing a route is then a deliberate, greppable act
 * rather than the consequence of forgetting a decorator — the failure mode of the
 * opposite arrangement is a route nobody remembered to guard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Every listed permission must be present. */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Injects the authenticated user. Typed as possibly undefined so a handler on a
 * `@Public()` route cannot silently assume one is there.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    getAuthenticatedUser(context.switchToHttp().getRequest<Request>()),
);
