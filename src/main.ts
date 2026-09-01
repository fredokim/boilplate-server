import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppConfig } from './config/app.config';
import { setupSwagger, SWAGGER_PATH } from './swagger';
import { useWebSocketAdapter } from './websocketAdapter';
import { installShutdownHandlers } from './shutdown';
import { LOGGER, type LoggerPort } from './common/logging/logger.port';

/**
 * Bootstrap does transport concerns only. The request pipeline itself — validation,
 * the response envelope, error mapping, logging — lives in `AppModule` so tests
 * exercise the same stack. See the note there.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Body parsing is registered below with an explicit limit rather than the
    // framework default, so an oversized payload is rejected at the edge.
    bodyParser: false,
  });

  const config = app.get(AppConfig);

  app.useLogger(logLevelsFor(config.logLevel));

  /**
   * Security headers. The content security policy is disabled here on purpose:
   * this process serves JSON and Swagger, not the application, and a CSP that
   * only covers the API would give the impression the frontend is protected when
   * it is not. The frontend's own host is where that belongs.
   */
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.setGlobalPrefix('api');
  useWebSocketAdapter(app);

  app.useBodyParser('json', { limit: config.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.bodyLimit, extended: true });

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  // Lets Nest run OnModuleDestroy hooks — notably Prisma's $disconnect — when the
  // process receives SIGTERM, instead of dropping connections mid-query.
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    setupSwagger(app);
  }

  // Off by default. Behind a load balancer it must be enabled, or every request
  // and every session records the balancer's address instead of the client's.
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  installShutdownHandlers(app, app.get<LoggerPort>(LOGGER));

  await app.listen(config.port);

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://localhost:${String(config.port)}/api`);
  if (config.swaggerEnabled) {
    logger.log(`API docs on http://localhost:${String(config.port)}/${SWAGGER_PATH}`);
  }
}

/** Nest takes a list of enabled levels, not a threshold, so expand it here. */
function logLevelsFor(level: string): ('error' | 'warn' | 'log' | 'debug' | 'verbose')[] {
  const order = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  const index = order.indexOf(level as (typeof order)[number]);
  return [...order.slice(0, index === -1 ? 3 : index + 1)];
}

void bootstrap();
