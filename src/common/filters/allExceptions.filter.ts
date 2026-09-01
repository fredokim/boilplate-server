import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfig } from '../../config/app.config';
import { type ApiErrorBody, toErrorEnvelope } from '../contracts/apiEnvelope';
import { defaultCodeForStatus, ErrorCode } from '../contracts/errorCode';
import { AppException } from '../exceptions/appException';
import { getRoutePath, HTTP_SERVER_ERROR_MIN } from '../http/requestPath';
import { LOGGER, type LoggerPort } from '../logging/logger.port';
import { getRequestId } from '../middleware/requestId.middleware';

/**
 * Turns every thrown value into the documented error envelope. Nothing else in
 * the server writes an error body.
 *
 * The central rule is that an unexpected failure tells the client nothing about
 * itself. In production an unhandled error becomes a generic 500 with no
 * message, no stack, and no details; the real cause goes to the log with the
 * request id, which is how it gets correlated. In development the cause is
 * echoed into `details` because the alternative is debugging a blank 500.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly logger: LoggerPort,
    private readonly config: AppConfig,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = getRequestId(request);

    const { status, body } = this.describe(exception);

    const where = {
      requestId,
      method: request.method,
      path: getRoutePath(request),
      statusCode: status,
    };

    if (!(exception instanceof HttpException)) {
      // Genuinely unexpected: nobody wrote this outcome down, so capture everything.
      this.logger.error('unhandled_exception', {
        ...where,
        errorName: exception instanceof Error ? exception.name : typeof exception,
        errorMessage: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    } else if (status >= HTTP_SERVER_ERROR_MIN) {
      // A deliberate 5xx — `AppException.serviceUnavailable` from the readiness
      // probe is the common one. It gets a line, but no stack: the throw site is
      // already named by the code, and a probe polling every few seconds during a
      // database outage would otherwise bury the log in identical traces.
      this.logger.error('server_error_response', {
        ...where,
        code: body.code,
        errorMessage: body.message,
        cause: exception instanceof AppException ? exception.cause : undefined,
      });
    }
    // Deliberate 4xx responses are left to the access log, which already records
    // the method, path, status, and duration.

    if (response.headersSent) {
      // Streaming or a partially written response — there is no envelope to send.
      return;
    }

    response.status(status).json(toErrorEnvelope(body));
  }

  private describe(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          code: defaultCodeForStatus(status),
          message: extractMessage(exception),
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        ...(this.config.isProduction ? {} : { details: developmentDetails(exception) }),
      },
    };
  }
}

/**
 * Nest packs its built-in exceptions as either a string or
 * `{ statusCode, message, error }`, where `message` may itself be an array.
 */
function extractMessage(exception: HttpException): string {
  const payload = exception.getResponse();

  if (typeof payload === 'string') return payload;

  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join(', ');
  }

  return exception.message;
}

function developmentDetails(exception: unknown): Record<string, unknown> {
  if (exception instanceof Error) {
    return {
      name: exception.name,
      originalMessage: exception.message,
      stack: exception.stack?.split('\n').slice(0, 10) ?? [],
    };
  }

  return { thrown: String(exception) };
}
