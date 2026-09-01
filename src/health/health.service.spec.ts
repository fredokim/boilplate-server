import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/appException';
import { ErrorCode } from '../common/contracts/errorCode';
import type { ComponentHealth, DatabaseHealthIndicator } from './databaseHealth.port';
import { HealthService } from './health.service';
import { installShutdownHandlers, isDraining, resetDrainingForTests } from '../shutdown';

function indicator(health: ComponentHealth): DatabaseHealthIndicator {
  return { check: () => Promise.resolve(health) };
}

const up: ComponentHealth = { status: 'up', latencyMs: 1 };
const down: ComponentHealth = { status: 'down', error: 'connection refused' };

describe('HealthService', () => {
  afterEach(() => {
    resetDrainingForTests();
  });

  describe('liveness', () => {
    /**
     * The property the whole liveness/readiness split rests on. A liveness probe
     * that failed on a database outage would get every container in the fleet
     * killed — which fixes nothing and removes the capacity needed to recover.
     */
    it('passes regardless of the database', () => {
      const service = new HealthService(indicator(down));

      expect(service.live()).toMatchObject({ status: 'ok' });
    });

    it('reports uptime', () => {
      expect(new HealthService(indicator(up)).live().uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('readiness', () => {
    it('passes when the database answers', async () => {
      await expect(new HealthService(indicator(up)).ready()).resolves.toMatchObject({
        status: 'ok',
        checks: { database: { status: 'up' } },
      });
    });

    it('fails with the failing check named', async () => {
      try {
        await new HealthService(indicator(down)).ready();
        throw new Error('Expected readiness to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        const failure = error as AppException;
        expect(failure.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(failure.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
        expect(failure.details).toMatchObject({ checks: { database: { status: 'down' } } });
      }
    });
  });

  describe('summary', () => {
    it('answers 200 and reports degraded rather than failing', async () => {
      await expect(new HealthService(indicator(down)).summary()).resolves.toMatchObject({ status: 'degraded' });
    });
  });
});

describe('draining', () => {
  // Built per test. A shared mock accumulates calls across tests, which made the
  // "second signal" assertion fail for a reason that had nothing to do with it.
  type MockLogger = { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let logger: MockLogger;

  beforeEach(() => {
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    resetDrainingForTests();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('starts not draining', () => {
    expect(isDraining()).toBe(false);
  });

  /**
   * The ordering the whole drain depends on: readiness has to fail *before*
   * connections stop being accepted, or the requests dispatched in between are
   * simply lost. Liveness keeps passing — the process is not unhealthy, it is
   * leaving.
   */
  it('fails readiness as soon as SIGTERM arrives, while liveness still passes', async () => {
    const closed = jest.fn().mockResolvedValue(undefined);
    installShutdownHandlers({ close: closed } as never, logger, { drainTimeoutMs: 10_000 });

    process.emit('SIGTERM');

    expect(isDraining()).toBe(true);

    const service = new HealthService(indicator(up));
    expect(service.live()).toMatchObject({ status: 'ok' });

    try {
      await service.ready();
      throw new Error('Expected readiness to fail while draining.');
    } catch (error) {
      expect((error as AppException).details).toMatchObject({ draining: true });
    }
  });

  it('ignores a second signal rather than draining twice', () => {
    installShutdownHandlers({ close: jest.fn().mockResolvedValue(undefined) } as never, logger, {
      drainTimeoutMs: 10_000,
    });

    process.emit('SIGTERM');
    process.emit('SIGTERM');

    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
