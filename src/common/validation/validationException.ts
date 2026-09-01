import { HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { ErrorCode } from '../contracts/errorCode';
import { AppException } from '../exceptions/appException';

export type ValidationFieldErrors = Record<string, string[]>;

/**
 * Flattens class-validator's tree into `{ "path.to.field": ["message"] }`.
 *
 * The frontend needs to attach a message to an input, and an input is identified
 * by a path — not by a position in a nested error array. Array indices become
 * bracket segments (`items[0].name`) so the path matches how the form addresses
 * the value.
 */
export function flattenValidationErrors(errors: readonly ValidationError[], parentPath = ''): ValidationFieldErrors {
  const fields: ValidationFieldErrors = {};

  for (const error of errors) {
    const path = buildPath(parentPath, error.property);

    if (error.constraints) {
      const messages = Object.values(error.constraints);
      fields[path] = [...(fields[path] ?? []), ...messages];
    }

    if (error.children && error.children.length > 0) {
      for (const [childPath, messages] of Object.entries(flattenValidationErrors(error.children, path))) {
        fields[childPath] = [...(fields[childPath] ?? []), ...messages];
      }
    }
  }

  return fields;
}

function buildPath(parentPath: string, property: string): string {
  if (parentPath === '') return property;
  // A numeric property is an array index, which reads better in bracket form.
  return /^\d+$/.test(property) ? `${parentPath}[${property}]` : `${parentPath}.${property}`;
}

export class ValidationException extends AppException {
  constructor(fields: ValidationFieldErrors) {
    super({
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed.',
      details: { fields },
    });
    this.name = 'ValidationException';
  }
}
