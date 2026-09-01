import { AppException } from '../common/exceptions/appException';
import { ErrorCode } from '../common/contracts/errorCode';
import {
  assertGraphInvariants,
  type GraphEdgeInput,
  type GraphNodeInput,
  MAX_EDGES,
  MAX_NODES,
} from './graphInvariants';

function node(nodeId: string): GraphNodeInput {
  return { nodeId, type: 'router', label: nodeId, position: { x: 0, y: 0 }, metadata: {} };
}

function edge(edgeId: string, sourceNodeId: string, targetNodeId: string): GraphEdgeInput {
  return { edgeId, sourceNodeId, targetNodeId, metadata: {} };
}

function expectInvalidEdge(fn: () => void): AppException {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const failure = error as AppException;
    expect(failure.code).toBe(ErrorCode.GRAPH_INVALID_EDGE);
    return failure;
  }

  throw new Error('Expected the invariant check to throw.');
}

describe('assertGraphInvariants', () => {
  it('accepts a well-formed graph', () => {
    expect(() => {
      assertGraphInvariants([node('a'), node('b')], [edge('e1', 'a', 'b')]);
    }).not.toThrow();
  });

  it('accepts an empty graph', () => {
    expect(() => {
      assertGraphInvariants([], []);
    }).not.toThrow();
  });

  /**
   * A dangling edge renders as nothing and silently distorts every route
   * calculation, so it is refused rather than dropped.
   */
  it('names the missing node when an edge source does not exist', () => {
    const error = expectInvalidEdge(() => {
      assertGraphInvariants([node('a')], [edge('e1', 'ghost', 'a')]);
    });

    expect(error.details).toMatchObject({ edgeId: 'e1', missingNodeId: 'ghost' });
  });

  it('names the missing node when an edge target does not exist', () => {
    const error = expectInvalidEdge(() => {
      assertGraphInvariants([node('a')], [edge('e1', 'a', 'ghost')]);
    });

    expect(error.details).toMatchObject({ missingNodeId: 'ghost' });
  });

  it('refuses a self-loop', () => {
    const error = expectInvalidEdge(() => {
      assertGraphInvariants([node('a')], [edge('e1', 'a', 'a')]);
    });

    expect(error.details).toMatchObject({ edgeId: 'e1', nodeId: 'a' });
  });

  it('refuses duplicate node ids', () => {
    expectInvalidEdge(() => {
      assertGraphInvariants([node('a'), node('a')], []);
    });
  });

  it('refuses duplicate edge ids', () => {
    expectInvalidEdge(() => {
      assertGraphInvariants([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e1', 'b', 'a')]);
    });
  });

  /** A second edge over the same ordered pair is invisible and doubles traversals. */
  it('refuses a second edge between the same nodes in the same direction', () => {
    const error = expectInvalidEdge(() => {
      assertGraphInvariants([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'a', 'b')]);
    });

    expect(error.details).toMatchObject({ sourceNodeId: 'a', targetNodeId: 'b' });
  });

  /** Direction is meaningful in a topology: A→B and B→A are different links. */
  it('allows both directions between the same pair', () => {
    expect(() => {
      assertGraphInvariants([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
    }).not.toThrow();
  });

  it('caps node and edge counts', () => {
    const many = Array.from({ length: MAX_NODES + 1 }, (_unused, index) => node(`n-${String(index)}`));
    expectInvalidEdge(() => {
      assertGraphInvariants(many, []);
    });

    const nodes = [node('a'), node('b')];
    const edges = Array.from({ length: MAX_EDGES + 1 }, (_unused, index) => edge(`e-${String(index)}`, 'a', 'b'));
    expectInvalidEdge(() => {
      assertGraphInvariants(nodes, edges);
    });
  });

  /** Metadata is open, so the shape rules bound the structure but not the bytes. */
  it('caps metadata size per entity', () => {
    const heavy: GraphNodeInput = { ...node('a'), metadata: { blob: 'x'.repeat(20_000) } };

    const error = expectInvalidEdge(() => {
      assertGraphInvariants([heavy], []);
    });
    expect(error.details).toMatchObject({ maxBytes: expect.any(Number) as unknown });
  });
});
