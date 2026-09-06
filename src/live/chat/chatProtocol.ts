import type { ChatMessageView, ChatTombstone } from './chat.service';

/**
 * Every frame the chat socket can carry, named.
 *
 * The gateway's `send()` took `Record<string, unknown>`, so a frame with a typo
 * in its `type` compiled, shipped, and was silently ignored by clients that were
 * switching on the correct spelling. The wire format was described in prose and
 * enforced nowhere.
 *
 * These types are what `send()` accepts now. They are also what the three
 * frontends validate against, which is the point: one description, two ends.
 */

/** Named so a reader can tell a protocol failure from a domain one. */
export type ChatErrorCode =
  | 'BAD_REQUEST'
  | 'TOO_MANY_ROOMS'
  | 'AUTH_FORBIDDEN'
  | 'BROADCAST_NOT_FOUND';

export type ChatServerFrame =
  /** Sent once, immediately after a successful handshake. */
  | { type: 'ready'; connectionId: string }
  /**
   * The reply to `join`, sent *after* the replayed messages so a client knows
   * the catch-up is complete.
   *
   * `replayed` is how many messages preceded it — zero when the client asked for
   * none. A non-null `nextCursor` is the sequence to resume from: it means there
   * is more history than one page holds, and the rest comes over HTTP rather
   * than here. `latestSequence` is where the room stands now, which is how a
   * client decides whether it is still behind.
   */
  | {
      type: 'joined';
      broadcastId: string;
      replayed: number;
      nextCursor: number | null;
      latestSequence: number;
    }
  | { type: 'message'; message: ChatMessageView }
  /**
   * A message that was removed. Carries the tombstone's own fields, so it has
   * both `type: 'deleted'` and `kind: 'deleted'`; the second is the domain
   * event's discriminant travelling with it.
   */
  | ({ type: 'deleted' } & ChatTombstone)
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'pong'; at: number }
  /** Unprompted, on an interval. A client may use it to notice a dead link. */
  | { type: 'heartbeat'; at: number };

/** The `event` names the gateway subscribes to, with the payload each expects. */
export type ChatClientFrame =
  | { event: 'join'; data: { broadcastId: string; afterSequence?: number } }
  | { event: 'leave'; data: { broadcastId: string } }
  | { event: 'ping'; data?: undefined };

/**
 * The payload one client frame carries, named by its event.
 *
 * This exists so `ChatClientFrame` is load-bearing rather than decorative. It
 * was neither for a while: the union was declared here and the gateway's
 * `parseJoin` wrote its own return type by hand, so the two could disagree and
 * nothing would say so — a declaration that looks like a contract and enforces
 * nothing, which is the shape of defect this repository keeps finding.
 *
 * Deriving the parser's return type from the union means renaming a field here
 * fails the build at the handler that uses it.
 */
export type ChatClientPayload<TEvent extends ChatClientFrame['event']> = Extract<
  ChatClientFrame,
  { event: TEvent }
>['data'];
