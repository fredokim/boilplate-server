import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/contracts/errorCode';
import { AppException } from '../common/exceptions/appException';
import { toJsonValue } from '../database/jsonValue';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticatedUser';
import { assertGraphInvariants, type GraphEdgeInput, type GraphNodeInput } from './graphInvariants';
import { graphNotFound } from './topology/topology.service';

export type GraphSummary = {
  id: string;
  title: string;
  ownerId: string;
  visibility: 'private' | 'shared';
  version: number;
  sequence: number;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
};

export type GraphDetail = GraphSummary & {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
};

@Injectable()
export class GraphService {
  constructor(private readonly prisma: PrismaService) {}

  /** Only graphs the caller can see: their own, plus anything shared. */
  async list(user: AuthenticatedUser): Promise<GraphSummary[]> {
    const rows = await this.prisma.graph.findMany({
      where: { OR: [{ ownerId: user.id }, { visibility: 'shared' }] },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { nodes: true, edges: true } } },
    });

    return rows.map((row) => toSummary(row, row._count.nodes, row._count.edges));
  }

  async findVisible(graphId: string, user: AuthenticatedUser): Promise<GraphDetail> {
    const row = await this.prisma.graph.findUnique({
      where: { id: graphId },
      include: { nodes: true, edges: true },
    });

    // Same reasoning as dashboards: a graph the caller may not see is a 404, so
    // a distinct 403 cannot be used to confirm which ids exist.
    if (!row || (row.visibility !== 'shared' && row.ownerId !== user.id)) throw graphNotFound();

    return {
      ...toSummary(row, row.nodes.length, row.edges.length),
      nodes: row.nodes.map(toNodeInput),
      edges: row.edges.map(toEdgeInput),
    };
  }

  async create(user: AuthenticatedUser, id: string, title: string, visibility: 'private' | 'shared'): Promise<GraphDetail> {
    const existing = await this.prisma.graph.findUnique({ where: { id }, select: { id: true } });

    if (existing) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'A graph with that id already exists.',
        details: { graphId: id },
      });
    }

    await this.prisma.graph.create({ data: { id, title, ownerId: user.id, visibility } });

    return this.findVisible(id, user);
  }

  /**
   * Replaces the whole node and edge set in one transaction.
   *
   * A bulk replace rather than per-entity mutations: the editor works on a whole
   * document and sends it back, and applying that as a stream of adds and removes
   * would leave the graph momentarily invalid — an edge whose node has been
   * deleted but whose replacement has not arrived yet. Replacing atomically means
   * the invariants hold at every point a reader could observe.
   */
  async replaceContent(
    graphId: string,
    user: AuthenticatedUser,
    expectedVersion: number,
    nodes: GraphNodeInput[],
    edges: GraphEdgeInput[],
  ): Promise<GraphDetail> {
    const row = await this.prisma.graph.findUnique({ where: { id: graphId } });

    if (!row || (row.visibility !== 'shared' && row.ownerId !== user.id)) throw graphNotFound();

    if (row.ownerId !== user.id) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCode.GRAPH_FORBIDDEN,
        message: 'You do not own this graph.',
      });
    }

    // Before the transaction: a rejection here costs nothing, and the client gets
    // the specific reason rather than a rolled-back write.
    assertGraphInvariants(nodes, edges);

    await this.prisma.$transaction(async (tx) => {
      // The version is part of the match, so a stale writer updates no rows and
      // the whole transaction is abandoned before anything is deleted.
      const locked = await tx.graph.updateMany({
        where: { id: graphId, version: expectedVersion },
        data: { version: { increment: 1 } },
      });

      if (locked.count === 0) throw versionConflict(row.version);

      await tx.graphEdge.deleteMany({ where: { graphId } });
      await tx.graphNode.deleteMany({ where: { graphId } });

      await tx.graphNode.createMany({
        data: nodes.map((node) => ({
          graphId,
          nodeId: node.nodeId,
          type: node.type,
          label: node.label,
          positionX: node.position.x,
          positionY: node.position.y,
          metadata: toJsonValue(node.metadata),
        })),
      });

      await tx.graphEdge.createMany({
        data: edges.map((edge) => ({
          graphId,
          edgeId: edge.edgeId,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          label: edge.label ?? null,
          metadata: toJsonValue(edge.metadata),
        })),
      });
    });

    return this.findVisible(graphId, user);
  }

  async remove(graphId: string, user: AuthenticatedUser): Promise<void> {
    const row = await this.prisma.graph.findUnique({ where: { id: graphId } });

    if (!row || (row.visibility !== 'shared' && row.ownerId !== user.id)) throw graphNotFound();

    if (row.ownerId !== user.id) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCode.GRAPH_FORBIDDEN,
        message: 'You do not own this graph.',
      });
    }

    // Nodes, edges, and events cascade from the schema.
    await this.prisma.graph.delete({ where: { id: graphId } });
  }

  /** Visibility check used by the WebSocket gateway before it accepts a subscription. */
  async canSubscribe(graphId: string, user: AuthenticatedUser): Promise<boolean> {
    const row = await this.prisma.graph.findUnique({
      where: { id: graphId },
      select: { ownerId: true, visibility: true },
    });

    if (!row) return false;

    return row.visibility === 'shared' || row.ownerId === user.id;
  }
}

export function versionConflict(currentVersion: number): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ErrorCode.GRAPH_VERSION_CONFLICT,
    message: 'This graph changed since you loaded it.',
    details: { currentVersion },
  });
}

type GraphRow = {
  id: string;
  title: string;
  ownerId: string;
  visibility: string;
  version: number;
  sequence: number;
  updatedAt: Date;
};

function toSummary(row: GraphRow, nodeCount: number, edgeCount: number): GraphSummary {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.ownerId,
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    version: row.version,
    sequence: row.sequence,
    nodeCount,
    edgeCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toNodeInput(row: {
  nodeId: string;
  type: string;
  label: string;
  positionX: number;
  positionY: number;
  metadata: unknown;
}): GraphNodeInput {
  return {
    nodeId: row.nodeId,
    type: row.type,
    label: row.label,
    position: { x: row.positionX, y: row.positionY },
    metadata: asRecord(row.metadata),
  };
}

function toEdgeInput(row: {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
  metadata: unknown;
}): GraphEdgeInput {
  return {
    edgeId: row.edgeId,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    ...(row.label === null ? {} : { label: row.label }),
    metadata: asRecord(row.metadata),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
