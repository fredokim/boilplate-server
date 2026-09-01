import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Serves the built frontend from this process, so the app and the API answer on
 * one origin.
 *
 * That is a deployment requirement, not a convenience. The refresh token is an
 * HttpOnly cookie with `sameSite: 'lax'`; hosting the client on a different
 * origin means the browser never sends it, and every session ends silently when
 * its access token expires. The two WebSocket gateways push the same way — a
 * rewrite layer in front of a separate API host is where an upgrade request
 * usually stops working.
 *
 * In development this stays off: Vite serves the client and proxies `/api` here,
 * which reproduces the same single origin.
 */
export function serveClient(app: NestExpressApplication, clientDir: string): string | null {
  if (clientDir === '') return null;

  const root = resolve(process.cwd(), clientDir);
  const indexPath = join(root, 'index.html');

  // Configured but absent is a mistake worth failing on. Serving the API alone
  // would look like a working deploy right up until someone opens the page.
  if (!existsSync(indexPath)) {
    throw new Error(`CLIENT_DIR is set to "${clientDir}" but ${indexPath} does not exist.`);
  }

  /**
   * `index: false` so the directory handler never answers `/` itself — the
   * fallback below owns every navigation, which keeps one place deciding what
   * an unknown path means.
   *
   * Hashed assets are immutable by construction: a changed file gets a changed
   * name. index.html is the opposite and must never be cached, or a browser
   * keeps requesting the previous build's assets after a deploy.
   */
  app.useStaticAssets(root, {
    index: false,
    setHeaders: (response: ServerResponse, filePath: string) => {
      response.setHeader(
        'Cache-Control',
        filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      );
    },
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    // Anything under the global prefix belongs to Nest, including the gateway
    // paths. Answering those with index.html would turn a missing route into a
    // 200 full of HTML — which the client only discovers later, at DTO
    // validation, pointing at the wrong thing entirely.
    if (request.path.startsWith('/api')) return next();

    // A non-GET request to an unknown path is not a navigation. Handing it the
    // SPA would answer a mistyped POST with 200 and an HTML body.
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();

    return response.sendFile(indexPath, { headers: { 'Cache-Control': 'no-cache' } });
  });

  return root;
}
