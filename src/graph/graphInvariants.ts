import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../common/contracts/errorCode';
import { AppException } from '../common/exceptions/appException';

/**
 * The structural rules a stored graph must satisfy.
 *
 * The database enforces uniqueness of `(graphId, nodeId)` and `(graphId, edgeId)`,
 * but it cannot express the rules that actually matter for a topology: an edge
 * must point at nodes that exist, and it must not point at itself. Leaving those
 * to a foreign key would surface a constraint violation the client cannot act on;
 * checked here, they become `GRAPH_INVALID_EDGE` with the offending id named.
 */

export const MAX_NODES = 2_000;
export const MAX_EDGES = 6_000;
export const MAX_METADATA_BYTES = 8 * 1024;

export type GraphNodeInput = {
  nodeId: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  metadata: Record<string, unknown>;
};

export type GraphEdgeInput = {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  metadata: Record<string, unknown>;
};

function invalidEdge(message: string, details: Record<string, unknown>): AppException {
  return new AppException({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ErrorCode.GRAPH_INVALID_EDGE,
    message,
    details,
  });
}

function tooLarge(message: string, details: Record<string, unknown>): AppException {
  return new AppException({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ErrorCode.GRAPH_INVALID_EDGE,
    message,
    details,
  });
}

/**
 * Validates a whole graph in one pass.
 *
 * Policy, stated rather than implied:
 *
 * - **Dangling edges are refused.** An edge to a node that does not exist renders
 *   as nothing and silently distorts every route calculation.
 * - **Self-loops are refused.** The layout engine has no meaningful placement for
 *   one, and in a network topology it means nothing.
 * - **Duplicate edge ids are refused**, and so are two edges between the same
 *   ordered pair — the second is invisible on the canvas and doubles every
 *   traversal.
 *
 * Direction matters: A→B and B→A are two different edges and both are allowed.
 */
export function assertGraphInvariants(nodes: readonly GraphNodeInput[], edges: readonly GraphEdgeInput[]): void {
  if (nodes.length > MAX_NODES) {
    throw tooLarge(`A graph may hold at most ${String(MAX_NODES)} nodes.`, { received: nodes.length });
  }

  if (edges.length > MAX_EDGES) {
    throw tooLarge(`A graph may hold at most ${String(MAX_EDGES)} edges.`, { received: edges.length });
  }

  const nodeIds = new Set<string>();

  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) {
      throw invalidEdge('Node ids must be unique within a graph.', { nodeId: node.nodeId });
    }
    nodeIds.add(node.nodeId);
    assertMetadataSize(node.metadata, `node ${node.nodeId}`);
  }

  const edgeIds = new Set<string>();
  const pairs = new Set<string>();

  for (const edge of edges) {
    if (edgeIds.has(edge.edgeId)) {
      throw invalidEdge('Edge ids must be unique within a graph.', { edgeId: edge.edgeId });
    }
    edgeIds.add(edge.edgeId);

    if (edge.sourceNodeId === edge.targetNodeId) {
      throw invalidEdge('An edge cannot connect a node to itself.', {
        edgeId: edge.edgeId,
        nodeId: edge.sourceNodeId,
      });
    }

    if (!nodeIds.has(edge.sourceNodeId)) {
      throw invalidEdge('Edge source does not exist in this graph.', {
        edgeId: edge.edgeId,
        missingNodeId: edge.sourceNodeId,
      });
    }

    if (!nodeIds.has(edge.targetNodeId)) {
      throw invalidEdge('Edge target does not exist in this graph.', {
        edgeId: edge.edgeId,
        missingNodeId: edge.targetNodeId,
      });
    }

    const pair = `${edge.sourceNodeId}->${edge.targetNodeId}`;
    if (pairs.has(pair)) {
      throw invalidEdge('A duplicate edge already connects these nodes in this direction.', {
        edgeId: edge.edgeId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
      });
    }
    pairs.add(pair);

    assertMetadataSize(edge.metadata, `edge ${edge.edgeId}`);
  }
}

/**
 * Metadata is an open object, so the shape checks bound the structure but not the
 * bytes. Without this one node can carry an arbitrarily large document.
 */
function assertMetadataSize(metadata: Record<string, unknown>, subject: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');

  if (bytes > MAX_METADATA_BYTES) {
    throw tooLarge(`Metadata for ${subject} is too large.`, { bytes, maxBytes: MAX_METADATA_BYTES });
  }
}
