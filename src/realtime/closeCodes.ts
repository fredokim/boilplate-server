/**
 * Why a gateway closed a socket, in one table both of them use.
 *
 * The two gateways had grown separate tables. Chat had three codes, topology had
 * five, and the three they shared happened to agree — nothing made them. A client
 * that learns what 4429 means from one socket should not have to find out
 * whether the other agrees.
 *
 * The 4000–4999 range is reserved for the application by RFC 6455, and the
 * numbers echo their HTTP counterparts so that a reader who knows one knows the
 * other: 4401 is 401, 4403 is 403, 4429 is 429.
 */
export const REALTIME_CLOSE = {
  /** The handshake carried no credential, or one the server would not accept. */
  unauthenticated: 4401,

  /** Authenticated, but without the permission this stream requires. */
  forbidden: 4403,

  /** The client sent something this protocol does not define. */
  protocol: 4400,

  /** Too many messages in the window. The client should back off, not retry at once. */
  rateLimited: 4429,

  /**
   * The client stopped reading and its buffer grew past what the server will
   * hold. Dropping it protects the other connections; a browser tab that was
   * throttled while hidden is the ordinary cause.
   */
  slowConsumer: 4408,
} as const;

export type RealtimeCloseCode = (typeof REALTIME_CLOSE)[keyof typeof REALTIME_CLOSE];
