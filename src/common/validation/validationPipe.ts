import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { flattenValidationErrors, ValidationException } from './validationException';

/**
 * The single validation policy for the server.
 *
 * `whitelist` strips properties with no decorator and `forbidNonWhitelisted`
 * turns an unexpected property into a rejection rather than a silent drop —
 * a client sending `isAdmin: true` at a DTO that never declared it should be
 * told, not quietly ignored.
 *
 * `transform` is what makes a handler receive a real DTO instance instead of a
 * plain object, which the frontend's own `parseDto` mirrors on its side.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      // Route params and query strings arrive as strings; without this a
      // `@IsInt()` DTO field could never pass.
      enableImplicitConversion: true,
    },
    stopAtFirstError: false,
    exceptionFactory: (errors: ValidationError[]) => new ValidationException(flattenValidationErrors(errors)),
  });
}
