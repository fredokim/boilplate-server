import { Global, Module } from '@nestjs/common';
import { LOGGER } from './logger.port';
import { NestLoggerAdapter } from './nestLogger.adapter';

/**
 * Global so that filters, interceptors, and future feature modules can inject
 * `LOGGER` without each one re-importing this module. Replacing the transport is
 * a one-line change to `useClass` here.
 */
@Global()
@Module({
  providers: [{ provide: LOGGER, useClass: NestLoggerAdapter }],
  exports: [LOGGER],
})
export class LoggingModule {}
