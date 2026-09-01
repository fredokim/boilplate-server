import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../common/exceptions/appException';
import { isDraining } from '../shutdown';
import { DATABASE_HEALTH, type DatabaseHealthIndicator } from './databaseHealth.port';
import type { HealthSummaryDto, LivenessDto, ReadinessDto } from './dto/health.response.dto';

@Injectable()
export class HealthService {
  constructor(@Inject(DATABASE_HEALTH) private readonly database: DatabaseHealthIndicator) {}

  /**
   * Liveness answers one question: is this process still running and able to
   * serve? It deliberately checks no dependency. A liveness probe that fails
   * because the database is down gets the container killed and restarted, which
   * fixes nothing and removes capacity during exactly the wrong incident.
   */
  live(): LivenessDto {
    return { status: 'ok', uptimeSeconds: uptime() };
  }

  /**
   * Readiness answers a different question: should traffic be routed here right
   * now? A missing database means no, so this throws 503 and the standard error
   * envelope carries the failing checks in `details`.
   */
  async ready(): Promise<ReadinessDto> {
    // Draining fails readiness before anything else is checked. The load balancer
    // has to stop routing here before the process stops accepting, or the
    // requests in between are simply lost.
    if (isDraining()) {
      throw AppException.serviceUnavailable('This instance is shutting down.', { draining: true });
    }

    const checks = { database: await this.database.check() };
    const degraded = Object.values(checks).some((check) => check.status === 'down');

    if (degraded) {
      throw AppException.serviceUnavailable('One or more dependencies are unavailable.', { checks });
    }

    return { status: 'ok', checks };
  }

  /**
   * The human-facing summary. Unlike readiness it always answers 200 and reports
   * what it found, so a dashboard polling it sees a degraded state rather than an
   * error envelope it has to unpack.
   */
  async summary(): Promise<HealthSummaryDto> {
    const checks = { database: await this.database.check() };
    const degraded = Object.values(checks).some((check) => check.status === 'down');

    return { status: degraded ? 'degraded' : 'ok', uptimeSeconds: uptime(), checks };
  }
}

function uptime(): number {
  return Math.round(process.uptime() * 100) / 100;
}
