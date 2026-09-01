import { type ArgumentsHost, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { AppConfig } from '../../config/app.config';
import { ErrorCode } from '../contracts/errorCode';
import { AppException } from '../exceptions/appException';
import { ValidationException } from '../validation/validationException';
import { AllExceptionsFilter } from './allExceptions.filter';

type CapturedResponse = { status: number; body: unknown };

function createHost(headersSent = false): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };

  const response = {
    headersSent,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };

  const request = { method: 'GET', url: '/api/thing', requestId: 'req-123' };

  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

/**
 * Declared as plain jest.Mock properties rather than as `LoggerPort`. Reading
 * `logger.error.mock` off an interface method trips `unbound-method`, which is a
 * real hazard for class methods and noise for a mock object literal.
 */
type MockLogger = { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

function createLogger(): MockLogger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

const production = { isProduction: true } as AppConfig;
const development = { isProduction: false } as AppConfig;

describe('AllExceptionsFilter', () => {
  describe('deliberate failures', () => {
    it('maps an AppException to its own status, code, and details', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch(AppException.notFound('Node not found.', { nodeId: 'node-9' }), host);

      expect(captured.status).toBe(HttpStatus.NOT_FOUND);
      expect(captured.body).toEqual({
        success: false,
        error: { code: ErrorCode.NOT_FOUND, message: 'Node not found.', details: { nodeId: 'node-9' } },
      });
    });

    it('omits details entirely when the exception carries none', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch(AppException.unauthorized(), host);

      expect(captured.status).toBe(HttpStatus.UNAUTHORIZED);
      // The frontend branches on this exact code to classify a failure as auth.
      expect(captured.body).toEqual({
        success: false,
        error: { code: ErrorCode.AUTH_REQUIRED, message: 'Authentication is required.' },
      });
      expect(Object.keys((captured.body as { error: object }).error)).not.toContain('details');
    });

    it.each([
      [new NotFoundException('No route'), HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
      [new ForbiddenException('Nope'), HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN],
    ])('derives a code from a framework HttpException', (exception, status, code) => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch(exception, host);

      expect(captured.status).toBe(status);
      expect(captured.body).toMatchObject({ success: false, error: { code } });
    });

    it('joins the array message Nest produces for built-in exceptions', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch(new HttpException({ message: ['first', 'second'] }, HttpStatus.BAD_REQUEST), host);

      expect(captured.body).toMatchObject({ error: { message: 'first, second' } });
    });

    it('renders a validation failure with per-field messages', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch(new ValidationException({ email: ['email must be an email'] }), host);

      expect(captured.status).toBe(HttpStatus.BAD_REQUEST);
      expect(captured.body).toEqual({
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Request validation failed.',
          details: { fields: { email: ['email must be an email'] } },
        },
      });
    });

    it('does not log a stack for a deliberate 4xx', () => {
      const logger = createLogger();
      const filter = new AllExceptionsFilter(logger, production);
      const { host } = createHost();

      filter.catch(AppException.badRequest('Bad input.'), host);

      expect(logger.error).not.toHaveBeenCalled();
    });

    // A readiness probe polls every few seconds. During a database outage each
    // poll throws the same deliberate 503, and a stack per poll buries the log.
    it('logs a deliberate 5xx without a stack', () => {
      const logger = createLogger();
      const filter = new AllExceptionsFilter(logger, production);
      const { host } = createHost();

      filter.catch(
        AppException.serviceUnavailable('One or more dependencies are unavailable.', {
          checks: { database: { status: 'down' } },
        }),
        host,
      );

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [event, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
      expect(event).toBe('server_error_response');
      expect(fields.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
      expect(fields.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(fields).not.toHaveProperty('stack');
    });
  });

  describe('unexpected failures', () => {
    it('reveals nothing about the cause in production', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch(new Error('Connection string postgres://user:hunter2@db:5432 failed'), host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body).toEqual({
        success: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
      });

      // The strongest form of the assertion: the secret is absent from the whole
      // serialised body, not merely from the fields we thought to check.
      expect(JSON.stringify(captured.body)).not.toContain('hunter2');
      expect(JSON.stringify(captured.body)).not.toContain('stack');
    });

    it('still logs the full cause so it is recoverable from the log', () => {
      const logger = createLogger();
      const filter = new AllExceptionsFilter(logger, production);
      const { host } = createHost();

      filter.catch(new Error('boom'), host);

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
      expect(fields.errorMessage).toBe('boom');
      expect(fields.requestId).toBe('req-123');
      expect(fields.stack).toBeDefined();
    });

    it('includes the cause in details outside production', () => {
      const filter = new AllExceptionsFilter(createLogger(), development);
      const { host, captured } = createHost();

      filter.catch(new Error('boom'), host);

      expect(captured.body).toMatchObject({
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
          details: { originalMessage: 'boom' },
        },
      });
    });

    it('handles a thrown non-Error value', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost();

      filter.catch('just a string', host);

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body).toMatchObject({ error: { code: ErrorCode.INTERNAL_ERROR } });
    });

    it('writes nothing once the response has already started', () => {
      const filter = new AllExceptionsFilter(createLogger(), production);
      const { host, captured } = createHost(true);

      filter.catch(new Error('too late'), host);

      expect(captured.status).toBe(0);
      expect(captured.body).toBeUndefined();
    });
  });
});
