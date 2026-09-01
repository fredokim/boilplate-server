/**
 * The seam between application code and whatever actually writes logs.
 *
 * Nothing outside `nestLogger.adapter.ts` imports Nest's `Logger`. Swapping in
 * pino, OpenTelemetry, or a hosted collector later means writing one more
 * adapter and rebinding the token — no call sites change.
 */

export type LogFields = Record<string, unknown>;

export interface LoggerPort {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Injection token. Use `@Inject(LOGGER) private readonly logger: LoggerPort`. */
export const LOGGER = Symbol('LOGGER');
