import './openApiEnv';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { buildOpenApiDocument } from '../swagger';
import { useWebSocketAdapter } from '../websocketAdapter';

/**
 * Fails when the committed `openapi.json` no longer matches what the code
 * produces.
 *
 * The point is not the file — it is that the file is the thing other people read.
 * A spec that silently falls behind is worse than no spec: it looks authoritative
 * while describing an API that no longer exists, and the first person to trust it
 * writes a client against a contract nobody is keeping.
 *
 * The check is a byte comparison of the same serialisation the generator writes,
 * so a reordered property is a difference and a whitespace change is not.
 */
async function main(): Promise<void> {
  const target = resolve(__dirname, '..', '..', 'openapi.json');

  if (!existsSync(target)) {
    console.error('[openapi] No openapi.json found. Run `npm run openapi:generate` and commit the result.');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api');
  useWebSocketAdapter(app);
  await app.init();

  const generated = `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`;
  const committed = readFileSync(target, 'utf8');

  await app.close();

  // Carriage returns are normalised away before comparing. Git's autocrlf can
  // rewrite the file on checkout, and a failure caused by line endings says
  // nothing about the contract — it would only teach everyone to ignore this.
  if (normaliseNewlines(generated) === normaliseNewlines(committed)) {
    console.log('[openapi] Committed spec matches the code.');
    return;
  }

  // The diff itself is not printed: an OpenAPI document is thousands of lines and
  // a wall of them buries the one instruction that fixes it.
  console.error(
    '[openapi] The committed spec is out of date.\n' +
      '          Run `npm run openapi:generate` and commit openapi.json.\n' +
      `          committed: ${String(committed.length)} bytes, generated: ${String(generated.length)} bytes`,
  );
  process.exitCode = 1;
}

/**
 * Strips carriage returns so the comparison is about content, not checkout
 * settings. Built from a char code rather than a literal or an escape that a
 * generator might mangle.
 */
const CARRIAGE_RETURN = String.fromCharCode(13);

function normaliseNewlines(value: string): string {
  return value.split(CARRIAGE_RETURN).join('');
}

main().catch((error: unknown) => {
  console.error('[openapi] Drift check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
