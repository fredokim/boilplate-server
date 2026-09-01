/**
 * The event shape sent over the WebSocket, matched field for field to
 * `TopologyRealtimeEvent` in
 * `src/features/visual-graph/realtime/types.ts`.
 *
 * The frontend runtime store dedupes on `eventId` and orders on `sequence`, and
 * it was written before this server existed. Getting a field name wrong here does
 * not fail a build — it makes every event look like an unknown entity and the
 * graph quietly stops updating.
 */

export type TopologyEntity = 'node' | 'edge';

export type TopologyEventType =
  | 'NODE_STATUS_CHANGED'
  | 'EDGE_STATUS_CHANGED'
  | 'NODE_METRIC_UPDATED'
  | 'EDGE_METRIC_UPDATED';

export type TopologyEventPayload = { status: string } | { metrics: Record<string, number> };

export type TopologyRealtimeEvent = {
  eventId: string;
  topologyId: string;
  entityId: string;
  timestamp: number;
  sequence: number;
  type: TopologyEventType;
  payload: TopologyEventPayload;
};

/** The entity a type acts on, so a payload cannot be applied to the wrong table. */
export function entityForType(type: TopologyEventType): TopologyEntity {
  return type.startsWith('NODE_') ? 'node' : 'edge';
}

export function isMetricEvent(type: TopologyEventType): boolean {
  return type.endsWith('_METRIC_UPDATED');
}

/**
 * How far back a client may replay.
 *
 * Beyond this the gap is not recoverable from the event table and the client is
 * told to resync from a snapshot. The bound is what keeps the table from growing
 * without limit and what makes "can I replay this?" a decidable question rather
 * than a hope.
 */
export const EVENT_RETENTION = {
  maxEvents: 1_000,
  maxAgeMs: 15 * 60 * 1_000,
} as const;

export type ReplayDecision =
  | { kind: 'up-to-date' }
  | { kind: 'replay'; fromSequence: number }
  | { kind: 'resync'; reason: 'behind-retention' | 'ahead-of-server' };

/**
 * Decides what a reconnecting client needs, given the sequence it last saw.
 *
 * Three outcomes, and the third is the one worth naming: a client whose sequence
 * is *ahead* of the server is not a client that is up to date. It has state from
 * a stream that no longer exists — a different server, or a database that was
 * reset — and continuing would leave it permanently ignoring every event as
 * stale. It resyncs.
 */
export function decideReplay(
  clientSequence: number,
  serverSequence: number,
  oldestRetainedSequence: number | null,
): ReplayDecision {
  if (clientSequence > serverSequence) return { kind: 'resync', reason: 'ahead-of-server' };
  if (clientSequence === serverSequence) return { kind: 'up-to-date' };

  // Nothing retained but the server has moved on: the gap is unrecoverable.
  if (oldestRetainedSequence === null) return { kind: 'resync', reason: 'behind-retention' };

  // The client needs everything after its sequence. That is replayable only if
  // the first event it is missing is still retained.
  if (clientSequence + 1 < oldestRetainedSequence) return { kind: 'resync', reason: 'behind-retention' };

  return { kind: 'replay', fromSequence: clientSequence };
}
