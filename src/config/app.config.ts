import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables, LogLevel } from './env.validation';
import { NodeEnvironment } from './env.validation';

/**
 * A typed face over `ConfigService`, so no call site anywhere reaches for
 * `process.env` or passes a string key that could be misspelled. Every value
 * here was already validated at boot by `validateEnvironment`.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  get nodeEnv(): NodeEnvironment {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnvironment.Production;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnvironment.Test;
  }

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  get databaseUrl(): string {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  get bodyLimit(): string {
    return this.config.get('BODY_LIMIT', { infer: true });
  }

  get logLevel(): LogLevel {
    return this.config.get('LOG_LEVEL', { infer: true });
  }

  /** Swagger is opt-out via env, and never served in production. */
  get swaggerEnabled(): boolean {
    return this.config.get('SWAGGER_ENABLED', { infer: true }) && !this.isProduction;
  }

  // --- auth -----------------------------------------------------------------

  get jwtSecret(): string {
    return this.config.get('JWT_SECRET', { infer: true });
  }

  get accessTokenTtlSeconds(): number {
    return this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  get refreshTokenTtlMs(): number {
    return this.config.get('REFRESH_TTL_DAYS', { infer: true }) * 24 * 60 * 60 * 1_000;
  }

  get maxLoginAttempts(): number {
    return this.config.get('AUTH_MAX_LOGIN_ATTEMPTS', { infer: true });
  }

  get loginWindowMs(): number {
    return this.config.get('AUTH_LOGIN_WINDOW_SECONDS', { infer: true }) * 1_000;
  }

  get seedAdmin(): { email: string; password: string } | null {
    const email = this.config.get('SEED_ADMIN_EMAIL', { infer: true });
    const password = this.config.get('SEED_ADMIN_PASSWORD', { infer: true });
    return email !== '' && password !== '' ? { email, password } : null;
  }

  /**
   * `sameSite: 'lax'` rather than `'strict'`: the refresh cookie has to survive a
   * top-level navigation back into the app (an OAuth return, a link from an
   * email), and `strict` would drop it there and log the user out. It is not a
   * CSRF control on its own — the refresh endpoint is a POST that returns a token
   * in the body rather than acting on it, so a cross-site form post gains nothing.
   *
   * The path is narrowed to the auth routes so the cookie is not attached to
   * every request in the application.
   */
  get refreshCookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    maxAge: number;
    domain?: string;
  } {
    const domain = this.config.get('COOKIE_DOMAIN', { infer: true });

    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: this.refreshTokenTtlMs,
      ...(domain !== '' ? { domain } : {}),
    };
  }

  get corsOrigins(): string[] {
    return this.config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }
}
