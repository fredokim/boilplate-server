import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import { AccessTokenService } from '../tokens/accessToken.service';
import type { AuthenticatedRequest } from '../types/authenticatedUser';

/**
 * Applied globally in `AuthModule`, so every route is protected unless it carries
 * `@Public()`. See the note on that decorator for why the default runs this way
 * round.
 *
 * The guard does no database work: the access token carries its own claims and
 * verifying a signature is enough. That is what keeps authentication off the
 * critical path of every request.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearerToken(request);

    if (!token) throw unauthenticated('Authentication is required.');

    const user = await this.accessTokens.verify(token);

    if (!user) throw unauthenticated('Session is invalid or has expired.');

    request.user = user;
    return true;
  }
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;

  const [scheme, value] = header.split(' ');

  // Case-insensitive: RFC 7235 defines the scheme token that way, and clients do
  // send "bearer".
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;

  return value.trim() || null;
}

/**
 * Always `AUTH_REQUIRED`, whatever went wrong. The frontend's api client branches
 * on that exact code to decide a failure is an auth failure, and a client cannot
 * act differently on "expired" than on "malformed" anyway.
 */
function unauthenticated(message: string): AppException {
  return new AppException({ status: HttpStatus.UNAUTHORIZED, code: ErrorCode.AUTH_REQUIRED, message });
}
