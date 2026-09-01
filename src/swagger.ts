import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { REFRESH_COOKIE_NAME } from './auth/auth.constants';
import { ERROR_ENVELOPE_SCHEMA } from './common/decorators/apiEnvelope.decorator';

export const SWAGGER_PATH = 'api/docs';

/**
 * Shared by the running server and by `scripts/generate-openapi.ts`, so the
 * committed spec can never describe something different from what is served.
 *
 * The generated JSON is the intended input for contract checks against the
 * frontend DTOs later — the same envelope is declared on both sides today only
 * because two files agree, which is exactly the kind of agreement that rots.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('React Boilerplate API')
    .setDescription(
      'Backend for the React boilerplate. Every response uses the shared envelope: ' +
        '`{ success: true, data }` on success and `{ success: false, error: { code, message, details? } }` on failure. ' +
        'HTTP status describes the transport outcome; `error.code` describes the domain outcome.',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    // Declared so /api/auth/refresh documents what it actually reads. The cookie
    // is HttpOnly, so Swagger UI cannot send it from the browser — the scheme is
    // here to describe the contract, not to make it clickable.
    .addCookieAuth(REFRESH_COOKIE_NAME, { type: 'apiKey', in: 'cookie' }, REFRESH_COOKIE_NAME)
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Registered once here so individual routes can reference the error envelope
  // instead of repeating the schema.
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas['ApiErrorEnvelope'] = { ...ERROR_ENVELOPE_SCHEMA };

  return document;
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_PATH, app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true },
  });
}
