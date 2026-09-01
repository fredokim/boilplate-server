import { HttpStatus } from '@nestjs/common';

/**
 * Domain error codes are deliberately separate from HTTP status. The status tells
 * an intermediary what to do; the code tells the frontend what happened. Several
 * codes can share a status, and a code must be free to keep its meaning if the
 * status ever changes.
 *
 * `AUTH_REQUIRED` is not an arbitrary name: `src/core/api/apiClient.ts` on the
 * frontend already branches on that exact string to classify a failure as
 * `kind: 'auth'`. Renaming it here silently breaks that branch.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  /**
   * The frontend branches on this exact string in `src/core/api/apiClient.ts` to
   * classify a failure as `kind: 'auth'`. It covers a missing, expired, or
   * malformed access token — anything that says "authenticate again".
   */
  AUTH_REQUIRED: 'AUTH_REQUIRED',

  /**
   * Wrong email or wrong password, reported identically for both. Distinguishing
   * them turns the login form into an account-existence oracle.
   */
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  /** The credentials were right; the account is switched off. */
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',

  /**
   * A refresh token was presented that had already been rotated away or belonged
   * to a revoked family. The session is gone and cannot be resumed.
   */
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',

  /** The permission guard denied a request from a known, authenticated user. */
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',

  /** Any other 403 — one nobody attributed to a specific policy. */
  FORBIDDEN: 'FORBIDDEN',

  /**
   * No such dashboard, *or* one the caller may not see. The two are deliberately
   * the same answer: a distinct 403 would confirm that an id exists, which is
   * enough to enumerate other people's dashboards.
   */
  DASHBOARD_NOT_FOUND: 'DASHBOARD_NOT_FOUND',

  /** The caller can see the dashboard but may not change it. */
  DASHBOARD_FORBIDDEN: 'DASHBOARD_FORBIDDEN',

  /** Someone else wrote first. `details.currentVersion` says what to re-read. */
  DASHBOARD_VERSION_CONFLICT: 'DASHBOARD_VERSION_CONFLICT',

  /** The payload does not match the stored schema version. */
  DASHBOARD_INVALID_SCHEMA: 'DASHBOARD_INVALID_SCHEMA',

  /** Widget data could not be produced. Matches the existing MSW error contract. */
  DASHBOARD_UNAVAILABLE: 'DASHBOARD_UNAVAILABLE',

  /** No such graph, or one the caller may not see — the same answer, for the same reason as dashboards. */
  GRAPH_NOT_FOUND: 'GRAPH_NOT_FOUND',

  /** The caller can see the graph but may not change it. */
  GRAPH_FORBIDDEN: 'GRAPH_FORBIDDEN',

  /** Someone else edited the structure first. `details.currentVersion` says what to re-read. */
  GRAPH_VERSION_CONFLICT: 'GRAPH_VERSION_CONFLICT',

  /** A dangling endpoint, a self-loop, or a duplicate edge. `details` names which. */
  GRAPH_INVALID_EDGE: 'GRAPH_INVALID_EDGE',

  /**
   * The client's last sequence is older than the retained event window, so the
   * gap cannot be replayed. It must take a fresh snapshot instead.
   */
  TOPOLOGY_RESYNC_REQUIRED: 'TOPOLOGY_RESYNC_REQUIRED',

  /** No such broadcast. */
  BROADCAST_NOT_FOUND: 'BROADCAST_NOT_FOUND',

  /** A transition the state machine does not allow, e.g. ended back to live. */
  BROADCAST_INVALID_TRANSITION: 'BROADCAST_INVALID_TRANSITION',

  /** Playback was requested for a broadcast that is not live. */
  BROADCAST_NOT_PLAYABLE: 'BROADCAST_NOT_PLAYABLE',

  /** The playback session expired or was revoked. */
  PLAYBACK_SESSION_EXPIRED: 'PLAYBACK_SESSION_EXPIRED',

  /** The author is muted for this broadcast. `details.until` when it is temporary. */
  CHAT_USER_MUTED: 'CHAT_USER_MUTED',

  /** Sending faster than the per-broadcast budget allows. */
  CHAT_RATE_LIMITED: 'CHAT_RATE_LIMITED',

  /** Chat is closed because the broadcast ended. */
  CHAT_CLOSED: 'CHAT_CLOSED',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE: 'UNPROCESSABLE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  BAD_REQUEST: 'BAD_REQUEST',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Fallback used when a thrown `HttpException` carries no explicit code — most
 * often one Nest itself raised, such as the 404 for an unmatched route.
 */
export function defaultCodeForStatus(status: HttpStatus): ErrorCodeValue {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.BAD_REQUEST;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.AUTH_REQUIRED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.METHOD_NOT_ALLOWED:
      return ErrorCode.METHOD_NOT_ALLOWED;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ErrorCode.UNPROCESSABLE;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.TOO_MANY_REQUESTS;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return status >= HttpStatus.INTERNAL_SERVER_ERROR ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
  }
}
