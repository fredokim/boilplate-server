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
import { serveClient } from './staticClient';
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
   * Security headers.
   *
   * The CSP follows what this process actually serves. With CLIENT_DIR set it
   * serves the application, so a policy belongs here — this is the frontend's
   * host. Without it the process serves JSON and Swagger, and a CSP covering
   * only an API would suggest a protection the app does not have.
   *
   * `style-src` allows inline: the grid layout library writes element styles
   * directly, and nothing in the bundle can change that. `script-src` does not,
   * which is the half that matters for injected markup.
   */
  const servesClient = config.clientDir !== '';

  app.use(
    helmet({
      contentSecurityPolicy: servesClient
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'blob:'],
              mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
              connectSrc: ["'self'", 'ws:', 'wss:'],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  // After helmet, so the static responses carry the same headers as the API's.
  // Registered before the router, which is safe because the fallback hands
  // everything under the global prefix straight back to Nest.
  const clientDir = serveClient(app, config.clientDir);

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

  if (clientDir) logger.log(`Serving the client from ${clientDir}`);
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
