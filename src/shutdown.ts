import type { INestApplication } from '@nestjs/common';
import type { LoggerPort } from './common/logging/logger.port';

/**
 * Whether the process has begun shutting down.
 *
 * Readiness reads this, so the very first thing SIGTERM does is take the instance
 * out of rotation. That ordering is the whole point: a load balancer needs to
 * stop sending work *before* the process stops accepting it, or the requests in
 * between are simply lost.
 */
let draining = false;

export function isDraining(): boolean {
  return draining;
}

export type ShutdownOptions = {
  /** How long in-flight requests are given before the process exits anyway. */
  drainTimeoutMs: number;
};

/**
 * Drains and exits in a deliberate order:
 *
 * 1. **Mark draining.** Readiness starts failing immediately, so the load
 *    balancer stops routing here while liveness still passes — the process is not
 *    unhealthy, it is leaving.
 * 2. **Wait a grace period.** A load balancer notices a readiness change on its
 *    own polling interval, not instantly. Closing the server the moment SIGTERM
 *    arrives would refuse requests that were dispatched before it noticed.
 * 3. **Close the HTTP server and the gateways.** `app.close()` stops accepting
 *    connections, runs every `onModuleDestroy` — which disconnects Prisma — and
 *    lets in-flight work finish.
 * 4. **Exit.**
 *
 * A hard timeout sits over the whole thing: a request that will not finish must
 * not keep the process alive forever, because an orchestrator will eventually
 * send SIGKILL and that is a worse ending than a controlled one.
 */
export function installShutdownHandlers(
  app: INestApplication,
  logger: LoggerPort,
  options: ShutdownOptions = { drainTimeoutMs: 10_000 },
): void {
  const shutdown = (signal: string): void => {
    if (draining) return;
    draining = true;

    logger.info('shutdown_started', { signal, drainTimeoutMs: options.drainTimeoutMs });

    // The hard stop. Unreferenced so it never keeps an otherwise-idle process up.
    const hardExit = setTimeout(() => {
      logger.error('shutdown_timed_out', { signal });
      process.exit(1);
    }, options.drainTimeoutMs);
    hardExit.unref();

    // A short pause so readiness has visibly failed before connections stop being
    // accepted. Deliberately shorter than the drain timeout.
    setTimeout(() => {
      void app
        .close()
        .then(() => {
          logger.info('shutdown_complete', { signal });
          clearTimeout(hardExit);
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error('shutdown_failed', {
            signal,
            reason: error instanceof Error ? error.message : String(error),
          });
          process.exit(1);
        });
    }, Math.min(2_000, options.drainTimeoutMs / 2)).unref();
  };

  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

/** Test hook. Nothing in production resets this — a draining process stays draining. */
export function resetDrainingForTests(): void {
  draining = false;
}
