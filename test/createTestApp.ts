import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { useWebSocketAdapter } from '../src/websocketAdapter';
import { PrismaService } from '../src/database/prisma.service';
import { type ComponentHealth, DATABASE_HEALTH } from '../src/health/databaseHealth.port';

/**
 * Builds the real application — same modules, same global pipe, filter, and
 * interceptors — with only its outermost dependency replaced.
 *
 * Two providers are swapped and nothing else:
 *
 * - `DATABASE_HEALTH`, so a test can state what the database is doing instead of
 *   arranging for it to actually be down. This is why the readiness check depends
 *   on a token rather than on `PrismaService` directly.
 * - `PrismaService`, so no test attempts a TCP connection. The real service
 *   already tolerates a failed connect, but a test that waits on a socket timeout
 *   is slow and flaky for no benefit.
 *
 * Everything under test — routing, validation, the envelope, error mapping — is
 * the production code path.
 */
export type TestAppOptions = {
  database?: ComponentHealth;
  controllers?: Type<unknown>[];
  /**
   * A stand-in for `PrismaService`. The auth suite passes the in-memory fake from
   * `authFixtures.ts`; everything else gets the inert stub below, which answers
   * every lifecycle call and stores nothing.
   */
  prisma?: unknown;
};

export async function createTestApp(options: TestAppOptions = {}): Promise<INestApplication> {
  const database: ComponentHealth = options.database ?? { status: 'up', latencyMs: 1 };

  const prismaStub = {
    onModuleInit: () => Promise.resolve(),
    onModuleDestroy: () => Promise.resolve(),
    $connect: () => Promise.resolve(),
    $disconnect: () => Promise.resolve(),
    ping: () => Promise.resolve(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(PrismaService)
    .useValue(options.prisma ?? prismaStub)
    .overrideProvider(DATABASE_HEALTH)
    .useValue({ check: () => Promise.resolve(database) })
    .compile();

  const app = moduleRef.createNestApplication();

  // main.ts sets this, so a test without it would exercise different URLs from
  // the ones that ship.
  app.setGlobalPrefix('api');
  // Gateways fail at init() with no adapter selected, so this has to match what
  // main.ts does — see the note in websocketAdapter.ts.
  useWebSocketAdapter(app);

  await app.init();
  return app;
}

/**
 * `INestApplication.getHttpServer()` is typed `any`, which would spread through
 * every supertest call. Named once here with a real type instead.
 */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
