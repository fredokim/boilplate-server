import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../contracts/errorCode';

export type AppExceptionOptions = {
  status: HttpStatus;
  /** Use a value from `ErrorCode`; the type stays open for module-specific codes. */
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** Original error, kept for logging only. It never reaches the response. */
  cause?: unknown;
};

/**
 * The one exception type application code should throw. It carries the domain
 * code and optional details alongside the HTTP status, so the exception filter
 * never has to guess at either.
 *
 * `cause` exists for the log, not the client — the filter reads it when writing
 * the log line and drops it when building the response body.
 */
export class AppException extends HttpException {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  override readonly cause: unknown;

  constructor(options: AppExceptionOptions) {
    super(options.message, options.status);
    this.name = 'AppException';
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }

  static notFound(message: string, details?: Record<string, unknown>) {
    return new AppException({ status: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND, message, details });
  }

  static badRequest(message: string, details?: Record<string, unknown>) {
    return new AppException({ status: HttpStatus.BAD_REQUEST, code: ErrorCode.BAD_REQUEST, message, details });
  }

  static unauthorized(message = 'Authentication is required.') {
    return new AppException({ status: HttpStatus.UNAUTHORIZED, code: ErrorCode.AUTH_REQUIRED, message });
  }

  static serviceUnavailable(message: string, details?: Record<string, unknown>) {
    return new AppException({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message,
      details,
    });
  }
}
