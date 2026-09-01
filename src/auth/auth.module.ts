import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticationGuard } from './guards/authentication.guard';
import { PermissionGuard } from './guards/permission.guard';
import { Argon2PasswordHasher } from './password/argon2PasswordHasher';
import { PASSWORD_HASHER } from './password/passwordHasher.port';
import { LOGIN_ATTEMPTS } from './rateLimit/loginAttempts.port';
import { MemoryLoginAttempts } from './rateLimit/memoryLoginAttempts';
import { RefreshSessionService } from './session/refreshSession.service';
import { AccessTokenService } from './tokens/accessToken.service';

/**
 * Both guards are registered globally, in this order.
 *
 * Authentication first, because the permission guard reads the user it puts on
 * the request; Nest runs `APP_GUARD` providers in registration order, so this is
 * a dependency rather than a preference.
 *
 * Guarding everything by default means the health endpoints and the auth routes
 * have to opt out with `@Public()`, which they do. The alternative — protect
 * routes as you remember to — fails silently, and the thing it fails at is
 * leaving an endpoint open.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    RefreshSessionService,
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: LOGIN_ATTEMPTS, useClass: MemoryLoginAttempts },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AccessTokenService],
})
export class AuthModule {}
