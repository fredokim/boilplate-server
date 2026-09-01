import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { LOGGER, type LoggerPort } from '../../common/logging/logger.port';
import { toJsonValue } from '../../database/jsonValue';
import { PrismaService } from '../../database/prisma.service';
import type { TransactionClient } from '../../database/transaction';
import {
  decideReplay,
  entityForType,
  EVENT_RETENTION,
  isMetricEvent,
  type ReplayDecision,
  type TopologyEventType,
  type TopologyRealtimeEvent,
} from './topologyEvent';

type RuntimeRow = {
  status: string;
  metrics: unknown;
  sequence: number;
  lastUpdated: Date;
};

export type TopologySnapshot = {
  topologyId: string;
  revision: number;
  capturedAt: number;
  nodes: Record<string, { status: string; metrics: Record<string, number>; lastUpdated: number; sequence: number }>;
  edges: Record<string, { status: string; metrics: Record<string, number>; lastUpdated: number; sequence: number }>;
};

export type PublishInput = {
  graphId: string;
  type: TopologyEventType;
  entityId: string;
  payload: { status?: string; metrics?: Record<string, number> };
};

@Injectable()
export class TopologyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {}

  /**
   * Reads current runtime state directly, rather than folding the event table.
   *
   * The events are a bounded replay buffer, not a source of truth — pruning them
   * would silently change the answer if a snapshot were derived from them.
   * `revision` is the graph's current sequence, so a client knows exactly where
   * the snapshot sits in the stream and what to ask for next.
   */
  async snapshot(graphId: string): Promise<TopologySnapshot> {
    const [graph, nodeRows, edgeRows] = await Promise.all([
      this.prisma.graph.findUnique({ where: { id: graphId } }),
      this.prisma.graphNodeRuntime.findMany({ where: { graphId } }),
      this.prisma.graphEdgeRuntime.findMany({ where: { graphId } }),
    ]);

    if (!graph) throw graphNotFound();

    return {
      topologyId: graphId,
      revision: graph.sequence,
      capturedAt: Date.now(),
      nodes: toRuntimeMap(nodeRows as unknown as ({ nodeId: string } & RuntimeRow)[], 'nodeId'),
      edges: toRuntimeMap(edgeRows as unknown as ({ edgeId: string } & RuntimeRow)[], 'edgeId'),
    };
  }

  /**
   * Allocates a sequence, stores the event, and applies it to runtime state — all
   * inside one transaction.
   *
   * The allocation is `{ increment: 1 }` on the graph row rather than a read
   * followed by a write, so two concurrent publishes cannot be handed the same
   * number. The unique constraint on `(graphId, sequence)` is the backstop: if
   * this reasoning is ever wrong, the second insert fails loudly instead of
   * producing two events that claim the same position in the stream.
   */
  async publish(input: PublishInput): Promise<TopologyRealtimeEvent> {
    const eventId = randomUUID();
    const entity = entityForType(input.type);

    const event = await this.prisma.$transaction(async (tx) => {
      const graph = await tx.graph.update({
        where: { id: input.graphId },
        data: { sequence: { increment: 1 } },
        select: { sequence: true },
      });

      const sequence = graph.sequence;
      const occurredAt = new Date();

      await tx.topologyEvent.create({
        data: {
          graphId: input.graphId,
          eventId,
          sequence,
          entity,
          entityId: input.entityId,
          kind: input.type,
          payload: toJsonValue(input.payload),
          occurredAt,
        },
      });

      await this.applyToRuntime(tx, input, sequence, occurredAt, entity);

      return {
        eventId,
        topologyId: input.graphId,
        entityId: input.entityId,
        timestamp: occurredAt.getTime(),
        sequence,
        type: input.type,
        payload: isMetricEvent(input.type)
          ? { metrics: input.payload.metrics ?? {} }
          : { status: input.payload.status ?? 'unknown' },
      } satisfies TopologyRealtimeEvent;
    });

    // Deliberately not logged per event. A busy topology emits hundreds a second
    // and an info line each would drown every other signal; the gateway records
    // aggregate counters instead.
    return event;
  }

  /**
   * What a reconnecting client needs. Returns the decision and, when replay is
   * possible, the events themselves.
   */
  async replayFor(graphId: string, clientSequence: number): Promise<{ decision: ReplayDecision; events: TopologyRealtimeEvent[] }> {
    const graph = await this.prisma.graph.findUnique({ where: { id: graphId }, select: { sequence: true } });
    if (!graph) throw graphNotFound();

    const oldest = await this.prisma.topologyEvent.findFirst({
      where: { graphId },
      orderBy: { sequence: 'asc' },
      select: { sequence: true },
    });

    const decision = decideReplay(clientSequence, graph.sequence, oldest?.sequence ?? null);

    if (decision.kind !== 'replay') return { decision, events: [] };

    const rows = await this.prisma.topologyEvent.findMany({
      where: { graphId, sequence: { gt: decision.fromSequence } },
      orderBy: { sequence: 'asc' },
      take: EVENT_RETENTION.maxEvents,
    });

    return { decision, events: rows.map(toRealtimeEvent) };
  }

  /** Refuses rather than replaying when the gap is unrecoverable. */
  resyncRequired(reason: string): AppException {
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ErrorCode.TOPOLOGY_RESYNC_REQUIRED,
      message: 'The requested events are no longer retained. Take a fresh snapshot.',
      details: { reason },
    });
  }

  /**
   * Drops events past the retention window.
   *
   * Called after publishing rather than on a timer: a graph nobody is writing to
   * needs no pruning, and a timer would keep the process awake for it.
   */
  async prune(graphId: string): Promise<number> {
    const cutoffDate = new Date(Date.now() - EVENT_RETENTION.maxAgeMs);

    const newest = await this.prisma.topologyEvent.findFirst({
      where: { graphId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    if (!newest) return 0;

    const cutoffSequence = newest.sequence - EVENT_RETENTION.maxEvents;

    const result = await this.prisma.topologyEvent.deleteMany({
      where: { graphId, OR: [{ sequence: { lte: cutoffSequence } }, { occurredAt: { lt: cutoffDate } }] },
    });

    if (result.count > 0) {
      this.logger.debug('topology_events_pruned', { graphId, pruned: result.count });
    }

    return result.count;
  }

  private async applyToRuntime(
    tx: TransactionClient,
    input: PublishInput,
    sequence: number,
    occurredAt: Date,
    entity: 'node' | 'edge',
  ): Promise<void> {
    const isMetric = isMetricEvent(input.type);

    if (entity === 'node') {
      const existing = await tx.graphNodeRuntime.findUnique({
        where: { graphId_nodeId: { graphId: input.graphId, nodeId: input.entityId } },
      });

      const next = mergeRuntime(existing, input, isMetric, sequence, occurredAt);

      await tx.graphNodeRuntime.upsert({
        where: { graphId_nodeId: { graphId: input.graphId, nodeId: input.entityId } },
        create: { graphId: input.graphId, nodeId: input.entityId, ...next, metrics: toJsonValue(next.metrics) },
        update: { ...next, metrics: toJsonValue(next.metrics) },
      });

      return;
    }

    const existing = await tx.graphEdgeRuntime.findUnique({
      where: { graphId_edgeId: { graphId: input.graphId, edgeId: input.entityId } },
    });

    const next = mergeRuntime(existing, input, isMetric, sequence, occurredAt);

    await tx.graphEdgeRuntime.upsert({
      where: { graphId_edgeId: { graphId: input.graphId, edgeId: input.entityId } },
      create: { graphId: input.graphId, edgeId: input.entityId, ...next, metrics: toJsonValue(next.metrics) },
      update: { ...next, metrics: toJsonValue(next.metrics) },
    });
  }
}

/**
 * Metrics merge, status replaces.
 *
 * A metric event carries only the metrics that changed, so overwriting the map
 * would delete every metric the event did not mention. A status event carries the
 * whole status, so there is nothing to merge.
 */
function mergeRuntime(
  existing: RuntimeRow | null,
  input: PublishInput,
  isMetric: boolean,
  sequence: number,
  occurredAt: Date,
): { status: string; metrics: Record<string, number>; sequence: number; lastUpdated: Date } {
  const currentMetrics = toMetrics(existing?.metrics);

  return {
    status: isMetric ? (existing?.status ?? 'unknown') : (input.payload.status ?? 'unknown'),
    metrics: isMetric ? { ...currentMetrics, ...(input.payload.metrics ?? {}) } : currentMetrics,
    sequence,
    lastUpdated: occurredAt,
  };
}

function toMetrics(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};

  const metrics: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) metrics[key] = entry;
  }

  return metrics;
}

function toRuntimeMap<TKey extends string>(
  rows: ({ [K in TKey]: string } & RuntimeRow)[],
  key: TKey,
): TopologySnapshot['nodes'] {
  const map: TopologySnapshot['nodes'] = {};

  for (const row of rows) {
    map[row[key]] = {
      status: row.status,
      metrics: toMetrics(row.metrics),
      lastUpdated: row.lastUpdated.getTime(),
      sequence: row.sequence,
    };
  }

  return map;
}

function toRealtimeEvent(row: {
  eventId: string;
  graphId: string;
  entityId: string;
  sequence: number;
  kind: string;
  payload: unknown;
  occurredAt: Date;
}): TopologyRealtimeEvent {
  const payload = (typeof row.payload === 'object' && row.payload !== null ? row.payload : {}) as {
    status?: string;
    metrics?: Record<string, number>;
  };

  return {
    eventId: row.eventId,
    topologyId: row.graphId,
    entityId: row.entityId,
    timestamp: row.occurredAt.getTime(),
    sequence: row.sequence,
    type: row.kind as TopologyEventType,
    payload: isMetricEvent(row.kind as TopologyEventType)
      ? { metrics: payload.metrics ?? {} }
      : { status: payload.status ?? 'unknown' },
  };
}

export function graphNotFound(): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ErrorCode.GRAPH_NOT_FOUND,
    message: 'Graph not found.',
  });
}
