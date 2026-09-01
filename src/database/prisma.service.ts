import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import { AppConfig } from '../config/app.config';
import { LOGGER, type LoggerPort } from '../common/logging/logger.port';

/**
 * Owns the Prisma connection lifecycle.
 *
 * A failed connection at startup is logged and swallowed rather than thrown.
 * That is deliberate and it is what makes the liveness/readiness split real: if
 * an unreachable database stopped the process from booting, `/health/live` could
 * never answer during an outage and an orchestrator would keep restarting a
 * container whose only problem is somewhere else. Instead the app comes up,
 * liveness passes, and readiness reports the database as down until it returns.
 *
 * `ping()` is therefore the honest check — it asks the database now rather than
 * trusting a flag set once at boot.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    config: AppConfig,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {
    super({
      datasourceUrl: config.databaseUrl,
      // Secret columns are excluded from every query by default. Reading one back
      // requires `omit: { passwordHash: false }` at the call site, which turns
      // "this query returns a password hash" into something visible in review
      // rather than something that happens because nobody wrote a `select`.
      omit: {
        user: { passwordHash: true },
        refreshSession: { tokenHash: true },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.info('database_connected');
    } catch (error) {
      this.logger.warn('database_connect_failed', {
        reason: error instanceof Error ? error.message : String(error),
        note: 'Server started without a database. /health/ready will report this until it recovers.',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Registered through app.enableShutdownHooks(), so an in-flight query gets
    // to finish before the process exits.
    await this.$disconnect();
  }

  /** Round-trips the cheapest possible statement. Throws if the database is unusable. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
