// Must come first: it sets configuration defaults that AppModule validates
// while it is being imported. See the note in that file.
import './openApiEnv';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { buildOpenApiDocument } from '../swagger';
import { useWebSocketAdapter } from '../websocketAdapter';

/**
 * Writes the OpenAPI document to disk without starting a listener.
 *
 * `createApplicationContext` is not enough here — the document is built by
 * walking the HTTP router, so the app has to be created as an HTTP application
 * and simply never told to listen.
 *
 * Run from the compiled output rather than through ts-node. ts-node installs a
 * module-resolution hook that cannot resolve the `#main-entry-point` subpath
 * import inside Prisma's generated client; plain Node handles the package
 * `imports` field correctly. Living under src/ is what lets the ordinary build
 * produce it.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api');
  // init() registers gateways, which refuse to start without an adapter.
  useWebSocketAdapter(app);
  await app.init();

  const document = buildOpenApiDocument(app);
  // dist/tools/ -> package root.
  const target = resolve(__dirname, '..', '..', 'openapi.json');

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();

  const routeCount = Object.keys(document.paths).length;
  console.log(`[openapi] Wrote ${String(routeCount)} paths to ${target}`);
}

main().catch((error: unknown) => {
  console.error('[openapi] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
