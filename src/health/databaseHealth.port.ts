/**
 * The readiness check depends on this interface, never on Prisma directly.
 *
 * That is what lets the e2e suite assert both a healthy and an unreachable
 * database by binding a stub to `DATABASE_HEALTH`, without a PostgreSQL server
 * anywhere near the test run.
 */

export type ComponentStatus = 'up' | 'down';

export type ComponentHealth = {
  status: ComponentStatus;
  latencyMs?: number;
  /** Present only when the component is down, and redacted in production. */
  error?: string;
};

export interface DatabaseHealthIndicator {
  check(): Promise<ComponentHealth>;
}

export const DATABASE_HEALTH = Symbol('DATABASE_HEALTH');
