import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GraphModule } from './graph/graph.module';
import { LiveModule } from './live/live.module';
import { AllExceptionsFilter } from './common/filters/allExceptions.filter';
import { RequestLoggingInterceptor } from './common/interceptors/requestLogging.interceptor';
import { ResponseEnvelopeInterceptor } from './common/interceptors/responseEnvelope.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { RequestIdMiddleware } from './common/middleware/requestId.middleware';
import { createValidationPipe } from './common/validation/validationPipe';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

/**
 * The pipe, filter, and interceptors are registered as providers rather than
 * through `app.useGlobalPipes()` in `main.ts`. Two reasons: they can then be
 * injected with `AppConfig` and `LOGGER`, and — just as important — a test that
 * builds the app from `AppModule` gets the exact same request pipeline as
 * production. Wiring them in `main.ts` would leave every e2e test exercising a
 * different stack from the one that ships.
 *
 * Interceptor order is registration order. Logging is outermost so its duration
 * covers the envelope mapping too.
 */
@Module({
  imports: [AppConfigModule, LoggingModule, DatabaseModule, AuthModule, DashboardModule, GraphModule, LiveModule, HealthModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Cookie parsing is middleware here rather than `app.use()` in main.ts for
    // the same reason the global enhancers are providers: otherwise the auth e2e
    // tests would run without it and read an empty refresh cookie.
    //
    // `'{*path}'`, not `'*'`. Express 5 requires a named wildcard; Nest 11 still
    // accepts the bare form but converts it and warns on every boot.
    consumer.apply(RequestIdMiddleware, cookieParser()).forRoutes('{*path}');
  }
}
