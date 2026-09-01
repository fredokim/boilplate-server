import { Injectable, Logger } from '@nestjs/common';
import type { LogFields, LoggerPort } from './logger.port';
import { redactValue } from './redact';

/**
 * The only file in the server that knows Nest's `Logger` exists.
 *
 * Records are emitted as single-line JSON so a collector can index the fields
 * without parsing prose. Nest's own transport still handles level filtering and
 * process output.
 */
@Injectable()
export class NestLoggerAdapter implements LoggerPort {
  private readonly logger = new Logger('App');

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(this.format(message, fields));
  }

  info(message: string, fields?: LogFields): void {
    this.logger.log(this.format(message, fields));
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(this.format(message, fields));
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(this.format(message, fields));
  }

  private format(message: string, fields?: LogFields): string {
    const record = { message, ...(fields ? (redactValue(fields) as LogFields) : {}) };

    try {
      return JSON.stringify(record);
    } catch {
      // A value that cannot be serialised must not take the request down with it.
      return JSON.stringify({ message, serialisation: 'failed' });
    }
  }
}
