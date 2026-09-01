import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Documents a route as returning the shared success envelope wrapping `model`.
 *
 * Without this every operation would advertise its bare DTO while actually
 * sending `{ success, data }`, and generated clients would be wrong on the first
 * call. The envelope is applied by an interceptor, so it has to be described
 * here rather than inferred from the handler's return type.
 */
export function ApiEnvelopeResponse<TModel extends Type<unknown>>(
  model: TModel,
  options: { status?: number; description?: string } = {},
) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Successful response.',
      schema: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: { $ref: getSchemaPath(model) },
        },
      },
    }),
  );
}

/**
 * The error half of the contract, shared by every failing response.
 *
 * Deliberately not `as const`: Swagger's `SchemaObject` declares mutable arrays,
 * and a readonly literal is not assignable to it.
 */
export const ERROR_ENVELOPE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['success', 'error'],
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', example: 'VALIDATION_ERROR' },
        message: { type: 'string', example: 'Request validation failed.' },
        details: {
          type: 'object',
          additionalProperties: true,
          description: 'Present only when the error carries structured context.',
        },
      },
    },
  },
};

export function ApiErrorResponse(status: number, description: string) {
  return ApiResponse({ status, description, schema: ERROR_ENVELOPE_SCHEMA });
}
