import type { Request } from 'express';

/**
 * Express types `Request.route` as `any`, so every call site that reaches for it
 * silently opts out of type checking. It is narrowed once here instead.
 */
export function getRoutePath(request: Request): string {
  const route: unknown = (request as { route?: unknown }).route;

  if (typeof route === 'object' && route !== null) {
    const path: unknown = (route as { path?: unknown }).path;
    if (typeof path === 'string') return path;
  }

  // No matched route — a 404, or a request that failed before routing. Fall back
  // to the raw URL with the query string removed, since it routinely carries
  // tokens and identifiers that must not reach a log.
  return stripQuery(request.originalUrl || request.url);
}

export function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Plain numbers rather than `HttpStatus`, because the values being compared come
 * from Express as `number`. Comparing a number against a numeric enum member
 * type-checks but asserts a relationship that does not exist.
 */
export const HTTP_CLIENT_ERROR_MIN = 400;
export const HTTP_SERVER_ERROR_MIN = 500;
