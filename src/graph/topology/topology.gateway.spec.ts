import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../../config/app.config';
import { AccessTokenService } from '../../auth/tokens/accessToken.service';
import type { AuthenticatedUser } from '../../auth/types/authenticatedUser';
import type { GraphService } from '../graph.service';
import { TopologyBroadcaster } from './topology.broadcaster';
import { CLOSE, type SocketLike, TopologyGateway } from './topology.gateway';
import type { TopologyService } from './topology.service';
import type { TopologyRealtimeEvent } from './topologyEvent';

/**
 * The gateway is tested against a fake socket rather than a real WebSocket.
 * Everything under test — who may connect, who may subscribe, what a
 * reconnecting client is told, and when a slow one is dropped — is a decision in
 * this file, not in the transport.
 */

const config = { jwtSecret: 'a-secret-that-is-at-least-32-characters', accessTokenTtlSeconds: 900 } as AppConfig;
const tokens = new AccessTokenService(config);

const subscriber: AuthenticatedUser = {
  id: 'user-1',
  email: 'demo@example.com',
  name: 'Demo',
  role: 'admin',
  permissions: ['graph:read', 'topology:subscribe'],
};

const withoutPermission: AuthenticatedUser = { ...subscriber, permissions: ['graph:read'] };

class FakeSocket implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  messagesOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === type);
  }
}

function request(token?: string): IncomingMessage {
  return { url: token ? `/api/topology?token=${token}` : '/api/topology' } as IncomingMessage;
}

function createGateway(overrides: {
  canSubscribe?: boolean;
  replay?: Awaited<ReturnType<TopologyService['replayFor']>>;
} = {}) {
  const graphs = { canSubscribe: jest.fn().mockResolvedValue(overrides.canSubscribe ?? true) };
  const topology = {
    replayFor: jest.fn().mockResolvedValue(overrides.replay ?? { decision: { kind: 'up-to-date' }, events: [] }),
  };
  const broadcaster = new TopologyBroadcaster();
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const gateway = new TopologyGateway(
    tokens,
    graphs as unknown as GraphService,
    topology as unknown as TopologyService,
    broadcaster,
    logger,
  );

  return { gateway, graphs, topology, broadcaster, logger };
}

function event(sequence: number): TopologyRealtimeEvent {
  return {
    eventId: `evt-${String(sequence)}`,
    topologyId: 'graph-1',
    entityId: 'node-1',
    timestamp: 1,
    sequence,
    type: 'NODE_STATUS_CHANGED',
    payload: { status: 'healthy' },
  };
}

describe('TopologyGateway', () => {
  describe('handshake', () => {
    it('accepts a valid token and announces the connection', async () => {
      const { gateway } = createGateway();
      const socket = new FakeSocket();

      await gateway.handleConnection(socket, request(await tokens.issue(subscriber)));

      expect(socket.closed).toBeNull();
      expect(socket.messagesOfType('ready')).toHaveLength(1);
    });

    it.each([
      ['no token', undefined],
      ['a garbage token', 'not-a-jwt'],
    ])('closes with 4401 for %s', async (_label, token) => {
      const { gateway } = createGateway();
      const socket = new FakeSocket();

      await gateway.handleConnection(socket, request(token));

      expect(socket.closed?.code).toBe(CLOSE.unauthenticated);
    });

    /** A token signed elsewhere must not open a stream. */
    it('closes a token signed with another secret', async () => {
      const foreign = new AccessTokenService({ ...config, jwtSecret: 'another-secret-that-is-long-enough-32' } as AppConfig);
      const { gateway } = createGateway();
      const socket = new FakeSocket();

      await gateway.handleConnection(socket, request(await foreign.issue(subscriber)));

      expect(socket.closed?.code).toBe(CLOSE.unauthenticated);
    });
  });

  describe('subscribe', () => {
    async function connect(overrides?: Parameters<typeof createGateway>[0], user = subscriber) {
      const harness = createGateway(overrides);
      const socket = new FakeSocket();
      await harness.gateway.handleConnection(socket, request(await tokens.issue(user)));
      socket.sent.length = 0;

      return { ...harness, socket };
    }

    it('subscribes a permitted user', async () => {
      const { gateway, socket } = await connect();

      await gateway.handleSubscribe(socket, { graphId: 'graph-1' });

      expect(socket.messagesOfType('subscribed')).toEqual([{ type: 'subscribed', graphId: 'graph-1', replayed: 0 }]);
    });

    /** The token grants access to the stream, not to every graph on it. */
    it('refuses a user without topology:subscribe', async () => {
      const { gateway, socket } = await connect(undefined, withoutPermission);

      await gateway.handleSubscribe(socket, { graphId: 'graph-1' });

      expect(socket.messagesOfType('error')[0]).toMatchObject({ code: 'AUTH_FORBIDDEN' });
      expect(socket.messagesOfType('subscribed')).toHaveLength(0);
    });

    it('answers GRAPH_NOT_FOUND for a graph the caller cannot see', async () => {
      const { gateway, socket } = await connect({ canSubscribe: false });

      await gateway.handleSubscribe(socket, { graphId: 'someone-elses' });

      expect(socket.messagesOfType('error')[0]).toMatchObject({ code: 'GRAPH_NOT_FOUND' });
    });

    it.each([
      ['no graphId', {}],
      ['a non-integer sequence', { graphId: 'graph-1', lastSequence: 1.5 }],
      ['a negative sequence', { graphId: 'graph-1', lastSequence: -1 }],
      ['a non-object payload', 'graph-1'],
    ])('rejects %s as a protocol error', async (_label, payload) => {
      const { gateway, socket } = await connect();

      await gateway.handleSubscribe(socket, payload);

      expect(socket.messagesOfType('error')[0]).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('replays the events a reconnecting client missed', async () => {
      const { gateway, socket } = await connect({
        replay: { decision: { kind: 'replay', fromSequence: 3 }, events: [event(4), event(5)] },
      });

      await gateway.handleSubscribe(socket, { graphId: 'graph-1', lastSequence: 3 });

      expect(socket.messagesOfType('event')).toHaveLength(2);
      expect(socket.messagesOfType('subscribed')[0]).toMatchObject({ replayed: 2 });
    });

    /**
     * The client must be told to take a fresh snapshot rather than assume the
     * stream is continuous — silently subscribing would leave a permanent hole.
     */
    it('tells a client behind retention to resync instead of subscribing quietly', async () => {
      const { gateway, socket } = await connect({
        replay: { decision: { kind: 'resync', reason: 'behind-retention' }, events: [] },
      });

      await gateway.handleSubscribe(socket, { graphId: 'graph-1', lastSequence: 1 });

      expect(socket.messagesOfType('resync-required')[0]).toMatchObject({ reason: 'behind-retention' });
      expect(socket.messagesOfType('subscribed')).toHaveLength(0);
    });

    it('caps the number of subscriptions on one connection', async () => {
      const { gateway, socket } = await connect();

      for (let i = 0; i < 8; i += 1) await gateway.handleSubscribe(socket, { graphId: `graph-${String(i)}` });
      await gateway.handleSubscribe(socket, { graphId: 'graph-9' });

      expect(socket.messagesOfType('error')[0]).toMatchObject({ code: 'TOO_MANY_SUBSCRIPTIONS' });
    });

    it('closes a connection that floods the socket', async () => {
      const { gateway, socket } = await connect();

      for (let i = 0; i < 61; i += 1) await gateway.handleSubscribe(socket, { graphId: 'graph-1' });

      expect(socket.closed?.code).toBe(CLOSE.rateLimited);
    });
  });

  describe('fan-out', () => {
    async function connectSubscribed() {
      const harness = createGateway();
      const socket = new FakeSocket();
      await harness.gateway.handleConnection(socket, request(await tokens.issue(subscriber)));
      await harness.gateway.handleSubscribe(socket, { graphId: 'graph-1' });
      socket.sent.length = 0;

      return { ...harness, socket };
    }

    it('delivers a published event to subscribers', async () => {
      const { broadcaster, socket } = await connectSubscribed();

      broadcaster.publish('graph-1', event(1));

      expect(socket.messagesOfType('event')).toHaveLength(1);
    });

    it('does not deliver events for graphs a connection did not subscribe to', async () => {
      const { broadcaster, socket } = await connectSubscribed();

      broadcaster.publish('graph-2', event(1));

      expect(socket.messagesOfType('event')).toHaveLength(0);
    });

    /**
     * A slow consumer is disconnected, not buffered. Queueing for it moves the
     * problem into server memory and makes one bad client everyone's; a
     * disconnect is recoverable, because the client reconnects with its last
     * sequence and replays.
     */
    it('drops a consumer whose socket buffer has run away', async () => {
      const { broadcaster, socket, logger } = await connectSubscribed();
      socket.bufferedAmount = 10 * 1024 * 1024;

      broadcaster.publish('graph-1', event(1));

      expect(socket.closed?.code).toBe(CLOSE.slowConsumer);
      expect(logger.warn).toHaveBeenCalledWith('topology_slow_consumer_dropped', expect.any(Object));
    });

    it('stops delivering after disconnect', async () => {
      const { gateway, broadcaster, socket } = await connectSubscribed();

      gateway.handleDisconnect(socket);
      broadcaster.publish('graph-1', event(1));

      expect(socket.messagesOfType('event')).toHaveLength(0);
    });
  });

  it('answers a client ping so an idle connection is not mistaken for a dead one', async () => {
    const { gateway } = createGateway();
    const socket = new FakeSocket();
    await gateway.handleConnection(socket, request(await tokens.issue(subscriber)));

    gateway.handlePing(socket);

    expect(socket.messagesOfType('pong')).toHaveLength(1);
  });
});
