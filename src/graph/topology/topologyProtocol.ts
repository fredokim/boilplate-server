import type { TopologyRealtimeEvent } from './topologyEvent';

/**
 * Every frame the topology socket can carry, named.
 *
 * The gateway's `send()` took `Record<string, unknown>`, so a frame with a typo
 * in its `type` compiled and shipped, and a client switching on the correct
 * spelling ignored it in silence.
 *
 * Four words in this protocol are easy to confuse and mean different things.
 * They are spelled out here because getting them wrong produces a stream that
 * looks correct and is not:
 *
 * - `eventId` identifies one event. A client dedupes on it, because at-least-once
 *   delivery means the same event can arrive twice.
 * - `sequence` orders events within a graph. A client orders on it, and it is
 *   what a resume asks to continue from.
 * - `lastSequence` is the client's side of that: the highest `sequence` it has
 *   applied, sent with `subscribe` to ask for everything after it.
 * - `resync-required` says the server cannot serve that resume — the events the
 *   client missed have aged out of retention. The client must load a fresh
 *   snapshot rather than wait for more deltas.
 *
 * A graph's own version is not in this protocol at all. It belongs to the HTTP
 * document — the thing an optimistic lock compares — and reusing the word here
 * for a delta counter would invite exactly the mix-up this comment exists to
 * prevent.
 */

export type TopologyErrorCode =
  | 'BAD_REQUEST'
  | 'TOO_MANY_SUBSCRIPTIONS'
  | 'AUTH_FORBIDDEN'
  | 'GRAPH_NOT_FOUND';

export type TopologyServerFrame =
  /** Sent once, immediately after a successful handshake. */
  | { type: 'ready'; connectionId: string }
  /**
   * The reply to `subscribe`, sent *after* any replayed events. `replayed` is
   * how many preceded it — zero for a subscription that asked for no history.
   */
  | { type: 'subscribed'; graphId: string; replayed: number }
  | { type: 'event'; event: TopologyRealtimeEvent }
  /**
   * The resume point the client asked for is no longer available. `reason` says
   * why; the client's only correct response is to fetch a snapshot.
   */
  | { type: 'resync-required'; graphId: string; reason: string; lastSequence?: number }
  | { type: 'error'; code: TopologyErrorCode; message: string }
  | { type: 'pong'; at: number }
  /** Unprompted, on an interval. A client may use it to notice a dead link. */
  | { type: 'heartbeat'; at: number };

/** The `event` names the gateway subscribes to, with the payload each expects. */
export type TopologyClientFrame =
  | { event: 'subscribe'; data: { graphId: string; lastSequence?: number } }
  | { event: 'unsubscribe'; data: { graphId: string } }
  | { event: 'ping'; data?: undefined };

export type TopologyServerFrameType = TopologyServerFrame['type'];
