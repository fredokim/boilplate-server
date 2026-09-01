import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../contracts/apiEnvelope';

export type RequestWithId = Request & { requestId?: string };

/**
 * An inbound `x-request-id` is only trusted after sanitising. It is echoed into a
 * response header and into every log line, so an unchecked value would let a
 * caller inject newlines into the log or terminators into the header.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    const requestId =
      typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate.trim()) ? candidate.trim() : randomUUID();

    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}

/** Reads the id attached by the middleware, for logs and error bodies. */
export function getRequestId(req: unknown): string | undefined {
  if (typeof req !== 'object' || req === null) return undefined;
  const value = (req as RequestWithId).requestId;
  return typeof value === 'string' ? value : undefined;
}
