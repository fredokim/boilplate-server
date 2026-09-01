import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { REQUIRED_PERMISSIONS_KEY } from '../decorators/auth.decorators';
import type { AuthenticatedRequest } from '../types/authenticatedUser';

/**
 * Runs after `AuthenticationGuard`, which is what puts `request.user` there.
 * Registration order in `AuthModule` is therefore load-bearing.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;

    if (!user) {
      // A route that declares permissions but is also @Public() — a configuration
      // mistake rather than a client one. Refuse rather than let it through.
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCode.AUTH_REQUIRED,
        message: 'Authentication is required.',
      });
    }

    const missing = required.filter((permission) => !user.permissions.includes(permission));

    if (missing.length > 0) {
      // `missing` is returned deliberately. The caller is already authenticated,
      // so this tells them what to ask an administrator for rather than leaving
      // them to guess — it discloses nothing they could not learn by trying.
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCode.AUTH_FORBIDDEN,
        message: 'You do not have permission to do that.',
        details: { missingPermissions: missing },
      });
    }

    return true;
  }
}
