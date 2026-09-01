import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LOGGER, type LoggerPort } from '../../common/logging/logger.port';
import { AccessTokenService } from '../../auth/tokens/accessToken.service';
import type { AuthenticatedUser } from '../../auth/types/authenticatedUser';
import { GraphService } from '../graph.service';
import { TopologyBroadcaster } from './topology.broadcaster';
import { TopologyService } from './topology.service';

/**
 * Limits, all per connection. Without them one client can hold an unbounded
 * amount of server memory and attention.
 */
const MAX_SUBSCRIPTIONS = 8;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_MESSAGES_PER_WINDOW = 60;
const RATE_WINDOW_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Close codes. 4000+ is the application range; a client can branch on these to
 * decide whether reconnecting is worth trying.
 */
export const CLOSE = {
  unauthenticated: 4401,
  forbidden: 4403,
  rateLimited: 4429,
  slowConsumer: 4408,
  protocol: 4400,
} as const;

/** The minimum a socket has to look like, so tests need no real WebSocket. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

type Connection = {
  id: string;
  socket: SocketLike;
  user: AuthenticatedUser;
  subscriptions: Set<string>;
  messageTimes: number[];
};

/**
 * The topology stream.
 *
 * Authentication happens at the handshake, not per message: the access token
 * arrives as a query parameter because browsers cannot set headers on a
 * WebSocket upgrade. That is a real trade — the token appears in any proxy log
 * that records query strings — and it is why the access token is short-lived and
 * why the refresh token is never used here.
 *
 * Delivery is at-least-once and the server does not claim otherwise. A replayed
 * event may be delivered twice; the client dedupes on `eventId` and orders on
 * `sequence`, which is what makes the pair converge.
 */
@Injectable()
@WebSocketGateway({ path: '/api/topology' })
export class TopologyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly connections = new Map<SocketLike, Connection>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly graphs: GraphService,
    private readonly topology: TopologyService,
    private readonly broadcaster: TopologyBroadcaster,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {
    this.broadcaster.onEvent((graphId, event) => {
      this.fanOut(graphId, { type: 'event', event });
    });
  }

  async handleConnection(socket: SocketLike, request: IncomingMessage): Promise<void> {
    const token = readToken(request);
    const user = token ? await this.accessTokens.verify(token) : null;

    if (!user) {
      // No detail about why. A client that cannot authenticate learns only that.
      socket.close(CLOSE.unauthenticated, 'unauthenticated');
      return;
    }

    const connection: Connection = {
      id: randomId(),
      socket,
      user,
      subscriptions: new Set(),
      messageTimes: [],
    };

    this.connections.set(socket, connection);
    this.startHeartbeat();

    this.logger.info('topology_connected', { connectionId: connection.id, userId: user.id });
    send(socket, { type: 'ready', connectionId: connection.id });
  }

  handleDisconnect(socket: SocketLike): void {
    const connection = this.connections.get(socket);
    this.connections.delete(socket);

    if (connection) {
      this.logger.info('topology_disconnected', {
        connectionId: connection.id,
        subscriptions: connection.subscriptions.size,
      });
    }

    if (this.connections.size === 0) this.stopHeartbeat();
  }

  /**
   * Subscribe, optionally from a sequence the client already has.
   *
   * The reply is one of three things and the client acts differently on each:
   * `subscribed` with no backlog, `subscribed` with replayed events, or
   * `resync-required` — which means the gap is older than what is retained and
   * the client must take a fresh snapshot rather than assume continuity.
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(socket: SocketLike, payload: unknown): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) return;

    if (!this.withinRateLimit(connection)) {
      socket.close(CLOSE.rateLimited, 'rate-limited');
      return;
    }

    const request = parseSubscribe(payload);

    if (!request) {
      send(socket, { type: 'error', code: 'BAD_REQUEST', message: 'subscribe needs a graphId.' });
      return;
    }

    if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      send(socket, { type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS', message: 'Subscription limit reached.' });
      return;
    }

    // Permission is checked per graph, not once at connect: a token grants access
    // to the stream, not to every graph on it.
    if (!connection.user.permissions.includes('topology:subscribe')) {
      send(socket, { type: 'error', code: 'AUTH_FORBIDDEN', message: 'Missing topology:subscribe.' });
      return;
    }

    if (!(await this.graphs.canSubscribe(request.graphId, connection.user))) {
      // Same answer whether it does not exist or is not visible.
      send(socket, { type: 'error', code: 'GRAPH_NOT_FOUND', message: 'Graph not found.' });
      return;
    }

    connection.subscriptions.add(request.graphId);

    if (request.lastSequence === undefined) {
      send(socket, { type: 'subscribed', graphId: request.graphId, replayed: 0 });
      return;
    }

    const { decision, events } = await this.topology.replayFor(request.graphId, request.lastSequence);

    if (decision.kind === 'resync') {
      this.logger.info('topology_resync_required', {
        connectionId: connection.id,
        graphId: request.graphId,
        lastSequence: request.lastSequence,
        reason: decision.reason,
      });
      send(socket, { type: 'resync-required', graphId: request.graphId, reason: decision.reason });
      return;
    }

    for (const event of events) send(socket, { type: 'event', event });

    if (events.length > 0) {
      this.logger.info('topology_replayed', {
        connectionId: connection.id,
        graphId: request.graphId,
        replayed: events.length,
      });
    }

    send(socket, { type: 'subscribed', graphId: request.graphId, replayed: events.length });
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(socket: SocketLike, payload: unknown): void {
    const connection = this.connections.get(socket);
    const request = parseSubscribe(payload);

    if (connection && request) connection.subscriptions.delete(request.graphId);
  }

  /** Answers a client heartbeat so an idle connection is not mistaken for a dead one. */
  @SubscribeMessage('ping')
  handlePing(socket: SocketLike): void {
    send(socket, { type: 'pong', at: Date.now() });
  }

  /**
   * Sends to every connection subscribed to the graph, and drops the ones that
   * cannot keep up.
   *
   * A slow consumer is disconnected rather than queued. Buffering for it moves
   * the problem into server memory and makes one bad client everyone's problem;
   * disconnecting is recoverable, because the client reconnects with its last
   * sequence and replays.
   */
  private fanOut(graphId: string, message: Record<string, unknown>): void {
    for (const connection of this.connections.values()) {
      if (!connection.subscriptions.has(graphId)) continue;

      const buffered = connection.socket.bufferedAmount ?? 0;

      if (buffered > MAX_MESSAGE_BYTES * MAX_MESSAGES_PER_WINDOW) {
        this.logger.warn('topology_slow_consumer_dropped', {
          connectionId: connection.id,
          graphId,
          bufferedBytes: buffered,
        });
        connection.socket.close(CLOSE.slowConsumer, 'slow-consumer');
        this.connections.delete(connection.socket);
        continue;
      }

      send(connection.socket, message);
    }
  }

  private withinRateLimit(connection: Connection): boolean {
    const now = Date.now();
    connection.messageTimes = connection.messageTimes.filter((at) => now - at < RATE_WINDOW_MS);
    connection.messageTimes.push(now);

    return connection.messageTimes.length <= MAX_MESSAGES_PER_WINDOW;
  }

  /**
   * One timer for the whole gateway rather than one per connection, and stopped
   * when the last client leaves so an idle process is not held awake.
   */
  private startHeartbeat(): void {
    if (this.heartbeat) return;

    this.heartbeat = setInterval(() => {
      for (const connection of this.connections.values()) {
        send(connection.socket, { type: 'heartbeat', at: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

function send(socket: SocketLike, message: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A socket that has already closed is not an error worth propagating into a
    // fan-out loop; the disconnect handler will clean it up.
  }
}

/**
 * Reads the token from the upgrade URL.
 *
 * Browsers cannot set an Authorization header on a WebSocket handshake, so this
 * is the available option. The cost is that the token can appear in proxy access
 * logs — which is why it is the short-lived access token and never the refresh
 * token, and why the request path is logged without its query string elsewhere.
 */
function readToken(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token');

  return token && token.length > 0 ? token : null;
}

function parseSubscribe(payload: unknown): { graphId: string; lastSequence?: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const { graphId, lastSequence } = payload as { graphId?: unknown; lastSequence?: unknown };

  if (typeof graphId !== 'string' || graphId === '') return null;

  if (lastSequence === undefined) return { graphId };

  // A non-integer or negative sequence is a protocol error, not a request for
  // everything — treating it as 0 would replay the entire retained window.
  if (typeof lastSequence !== 'number' || !Number.isInteger(lastSequence) || lastSequence < 0) return null;

  return { graphId, lastSequence };
}

/** Correlates every log line for one connection. Not a secret, but not guessable either. */
function randomId(): string {
  return randomUUID().slice(0, 8);
}
