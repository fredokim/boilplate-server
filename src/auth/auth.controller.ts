import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../common/decorators/apiEnvelope.decorator';
import { AuthService } from './auth.service';
import { REFRESH_COOKIE_NAME } from './auth.constants';
import { AppConfig } from '../config/app.config';
import { CurrentUser, Public } from './decorators/auth.decorators';
import { LoginRequestDto, LoginResponseDto, LogoutResponseDto, SessionResponseDto } from './dto/auth.dto';
import type { AuthenticatedUser } from './types/authenticatedUser';
import type { RefreshContext } from './session/refreshSession.service';

/**
 * HTTP only: read the cookie, call the service, write the cookie. Every rule
 * about rotation, reuse, and lockout lives in the service, which is why those can
 * be tested without an HTTP layer at all.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Returns a short-lived access token in the body and sets the rotating refresh token as an HttpOnly cookie. The refresh token never appears in a response body.',
  })
  @ApiEnvelopeResponse(LoginResponseDto)
  @ApiErrorResponse(401, 'Invalid credentials.')
  @ApiErrorResponse(403, 'The account is disabled.')
  @ApiErrorResponse(429, 'Too many sign-in attempts.')
  async login(
    @Body() body: LoginRequestDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const result = await this.auth.login(body.email, body.password, requestContext(request));
    this.setRefreshCookie(response, result.refresh.token);

    return { accessToken: result.accessToken, user: result.user };
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE_NAME)
  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new access token',
    description:
      'Rotates the refresh token: the presented one is revoked as the replacement is issued. Presenting an already-used token revokes the whole session family.',
  })
  @ApiEnvelopeResponse(LoginResponseDto)
  @ApiErrorResponse(401, 'The refresh token is missing, expired, or already used.')
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<LoginResponseDto> {
    const token = readRefreshCookie(request);

    if (!token) {
      // Clear whatever unusable cookie the browser is holding, so the next
      // attempt is a clean sign-in rather than another failed refresh.
      this.clearRefreshCookie(response);
    }

    try {
      const result = await this.auth.refresh(token ?? '', requestContext(request));
      this.setRefreshCookie(response, result.refresh.token);

      return { accessToken: result.accessToken, user: result.user };
    } catch (error) {
      this.clearRefreshCookie(response);
      throw error;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End the current session',
    description:
      'Idempotent. Public because a client whose access token has already expired must still be able to log out.',
  })
  @ApiEnvelopeResponse(LogoutResponseDto)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<LogoutResponseDto> {
    const revoked = await this.auth.logout(readRefreshCookie(request));
    this.clearRefreshCookie(response);

    return { revoked };
  }

  @Get('session')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Read the current user',
    description: 'Re-reads the user from the database, so a role change or a disabled account takes effect at once.',
  })
  @ApiEnvelopeResponse(SessionResponseDto)
  @ApiErrorResponse(401, 'Authentication is required.')
  async session(@CurrentUser() user: AuthenticatedUser | undefined): Promise<SessionResponseDto> {
    // The global guard guarantees a user here; the non-null assertion would be
    // safe but this reads without one.
    return { user: await this.auth.session(user?.id ?? '') };
  }

  private setRefreshCookie(response: Response, token: string): void {
    response.cookie(REFRESH_COOKIE_NAME, token, this.config.refreshCookieOptions);
  }

  private clearRefreshCookie(response: Response): void {
    // Path and domain must match the ones the cookie was set with, or the browser
    // keeps the original and the "cleared" cookie is still sent.
    const { maxAge: _maxAge, ...options } = this.config.refreshCookieOptions;
    response.clearCookie(REFRESH_COOKIE_NAME, options);
  }
}

/** Express types `Request.cookies` as `any`, so it is narrowed here rather than trusted. */
function readRefreshCookie(request: Request): string | undefined {
  const cookies: unknown = (request as { cookies?: unknown }).cookies;

  if (typeof cookies !== 'object' || cookies === null) return undefined;

  const value: unknown = (cookies as Record<string, unknown>)[REFRESH_COOKIE_NAME];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Recorded on the session so a user can be shown where they are signed in, and so
 * a reuse can be traced. `request.ip` honours the trust-proxy setting, which is
 * off by default — behind a load balancer it must be enabled or every session
 * records the balancer's address.
 */
function requestContext(request: Request): RefreshContext {
  const userAgent = request.headers['user-agent'];

  return {
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : undefined,
    ipAddress: request.ip,
  };
}
