import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { getRoutePath, HTTP_CLIENT_ERROR_MIN, HTTP_SERVER_ERROR_MIN } from '../http/requestPath';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { LOGGER, type LoggerPort } from '../logging/logger.port';
import { getRequestId } from '../middleware/requestId.middleware';

/**
 * The access log: exactly one line per HTTP request, whether it succeeded or not.
 *
 * The exception filter also logs, but for a different reason — it records the
 * stack of an unexpected failure. This records that a request happened, how long
 * it took, and how it ended. Only the URL path is logged; the query string is
 * dropped because it routinely carries tokens and identifiers.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(@Inject(LOGGER) private readonly logger: LoggerPort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    const base = {
      method: request.method,
      path: getRoutePath(request),
      requestId: getRequestId(request),
    };

    return next.handle().pipe(
      tap({
        next: () => {
          this.write(base, response.statusCode, startedAt);
        },
        error: (error: unknown) => {
          const status =
            error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
          this.write(base, status, startedAt);
        },
      }),
    );
  }

  private write(base: Record<string, unknown>, statusCode: number, startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const fields = { ...base, statusCode, durationMs: Math.round(durationMs * 100) / 100 };

    if (statusCode >= HTTP_SERVER_ERROR_MIN) {
      this.logger.error('http_request', fields);
      return;
    }

    if (statusCode >= HTTP_CLIENT_ERROR_MIN) {
      this.logger.warn('http_request', fields);
      return;
    }

    this.logger.info('http_request', fields);
  }
}
