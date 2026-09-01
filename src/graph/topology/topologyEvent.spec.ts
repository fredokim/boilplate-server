import { decideReplay, entityForType, EVENT_RETENTION, isMetricEvent } from './topologyEvent';

describe('event classification', () => {
  it.each([
    ['NODE_STATUS_CHANGED', 'node'],
    ['NODE_METRIC_UPDATED', 'node'],
    ['EDGE_STATUS_CHANGED', 'edge'],
    ['EDGE_METRIC_UPDATED', 'edge'],
  ] as const)('routes %s to the %s table', (type, entity) => {
    expect(entityForType(type)).toBe(entity);
  });

  it.each([
    ['NODE_METRIC_UPDATED', true],
    ['EDGE_METRIC_UPDATED', true],
    ['NODE_STATUS_CHANGED', false],
    ['EDGE_STATUS_CHANGED', false],
  ] as const)('classifies %s as metric=%s', (type, expected) => {
    expect(isMetricEvent(type)).toBe(expected);
  });
});

describe('decideReplay', () => {
  it('says nothing is needed when the client is level with the server', () => {
    expect(decideReplay(10, 10, 1)).toEqual({ kind: 'up-to-date' });
  });

  it('replays from the client sequence when the gap is retained', () => {
    expect(decideReplay(7, 10, 5)).toEqual({ kind: 'replay', fromSequence: 7 });
  });

  /**
   * The boundary that matters: a client at N needs everything after N, so it can
   * replay only if event N+1 is still retained. Off by one here means silently
   * skipping an event and leaving the client permanently wrong.
   */
  it('replays when the first missing event is exactly the oldest retained one', () => {
    expect(decideReplay(4, 10, 5)).toEqual({ kind: 'replay', fromSequence: 4 });
  });

  it('resyncs when the first missing event has already been pruned', () => {
    expect(decideReplay(3, 10, 5)).toEqual({ kind: 'resync', reason: 'behind-retention' });
  });

  it('resyncs when nothing is retained but the server has moved on', () => {
    expect(decideReplay(3, 10, null)).toEqual({ kind: 'resync', reason: 'behind-retention' });
  });

  it('is up to date when nothing is retained and nothing has happened', () => {
    expect(decideReplay(0, 0, null)).toEqual({ kind: 'up-to-date' });
  });

  /**
   * A client ahead of the server is not up to date — it holds state from a stream
   * that no longer exists (a different instance, a reset database). Continuing
   * would leave it discarding every future event as stale.
   */
  it('resyncs a client whose sequence is ahead of the server', () => {
    expect(decideReplay(50, 10, 1)).toEqual({ kind: 'resync', reason: 'ahead-of-server' });
  });

  it('keeps a bounded retention window', () => {
    expect(EVENT_RETENTION.maxEvents).toBeGreaterThan(0);
    expect(EVENT_RETENTION.maxAgeMs).toBeGreaterThan(0);
  });
});
