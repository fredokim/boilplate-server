import { Injectable } from '@nestjs/common';
import { TimeoutError, withTimeout } from '../common/async/withTimeout';
import { AppConfig } from '../config/app.config';
import { PrismaService } from '../database/prisma.service';
import type { ComponentHealth, DatabaseHealthIndicator } from './databaseHealth.port';

/**
 * Shorter than Prisma's own connect timeout, which is around four seconds.
 *
 * A readiness probe is normally given one to three seconds by whatever is
 * polling it. Waiting on the driver means the caller gives up first and records
 * a probe timeout instead of the 503 that names the failing dependency. Answering
 * "down" quickly is more useful than answering precisely too late.
 */
const CHECK_TIMEOUT_MS = 1_500;

@Injectable()
export class PrismaHealthIndicator implements DatabaseHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async check(): Promise<ComponentHealth> {
    const startedAt = process.hrtime.bigint();

    try {
      await withTimeout(this.prisma.ping(), CHECK_TIMEOUT_MS);
      return { status: 'up', latencyMs: elapsedMs(startedAt) };
    } catch (error) {
      return { status: 'down', latencyMs: elapsedMs(startedAt), error: this.describe(error) };
    }
  }

  /**
   * A driver error can carry the host, port, and user from the connection string.
   * Health endpoints are frequently exposed more widely than the rest of the API,
   * so production gets a fixed string instead.
   */
  private describe(error: unknown): string {
    if (this.config.isProduction) return 'Database is unreachable.';
    if (error instanceof TimeoutError) return `Database did not respond within ${String(CHECK_TIMEOUT_MS)}ms.`;
    return error instanceof Error ? error.message : String(error);
  }
}

function elapsedMs(startedAt: bigint): number {
  return Math.round((Number(process.hrtime.bigint() - startedAt) / 1_000_000) * 100) / 100;
}
