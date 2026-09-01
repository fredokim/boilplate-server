import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { AccessTokenService } from '../../auth/tokens/accessToken.service';
import type { AuthenticatedUser } from '../../auth/types/authenticatedUser';
import { LOGGER, type LoggerPort } from '../../common/logging/logger.port';
import { ChatBroadcaster, type ChatEvent } from './chat.broadcaster';
import { ChatService } from './chat.service';

const MAX_ROOMS = 4;
const MAX_MESSAGES_PER_WINDOW = 60;
const RATE_WINDOW_MS = 10_000;
const MAX_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

export const CHAT_CLOSE = {
  unauthenticated: 4401,
  rateLimited: 4429,
  slowConsumer: 4408,
} as const;

export interface ChatSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

type ChatConnection = {
  id: string;
  socket: ChatSocketLike;
  user: AuthenticatedUser;
  rooms: Set<string>;
  messageTimes: number[];
};

/**
 * The live chat stream.
 *
 * Deliberately read-only. Sending goes over HTTP, where the idempotency key, the
 * rate limit, and the mute check already live — duplicating that path here would
 * mean two implementations of "may this person post?" that must agree forever.
 *
 * On join the client sends the sequence it already has and the gateway replies
 * with the history after it, so a reconnect does not refetch a whole room. The
 * frontend's bounded retention, pending cap, processed-id LRU, and flush batching
 * are all upstream and untouched.
 */
@Injectable()
@WebSocketGateway({ path: '/api/live/chat' })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly connections = new Map<ChatSocketLike, ChatConnection>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly chat: ChatService,
    private readonly broadcaster: ChatBroadcaster,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {
    this.broadcaster.onEvent((broadcastId, event) => {
      this.fanOut(broadcastId, event);
    });
  }

  async handleConnection(socket: ChatSocketLike, request: IncomingMessage): Promise<void> {
    const token = readToken(request);
    const user = token ? await this.accessTokens.verify(token) : null;

    if (!user) {
      socket.close(CHAT_CLOSE.unauthenticated, 'unauthenticated');
      return;
    }

    const connection: ChatConnection = {
      id: randomUUID().slice(0, 8),
      socket,
      user,
      rooms: new Set(),
      messageTimes: [],
    };

    this.connections.set(socket, connection);
    this.startHeartbeat();

    this.logger.info('chat_connected', { connectionId: connection.id, userId: user.id });
    send(socket, { type: 'ready', connectionId: connection.id });
  }

  handleDisconnect(socket: ChatSocketLike): void {
    const connection = this.connections.get(socket);
    this.connections.delete(socket);

    if (connection) {
      this.logger.info('chat_disconnected', { connectionId: connection.id, rooms: connection.rooms.size });
    }

    if (this.connections.size === 0) this.stopHeartbeat();
  }

  /**
   * Joins a room, optionally catching up from a sequence.
   *
   * The catch-up is bounded by one history page. A client further behind than
   * that gets what fits and a cursor, rather than the server trying to stream an
   * entire room down a socket.
   */
  @SubscribeMessage('join')
  async handleJoin(socket: ChatSocketLike, payload: unknown): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) return;

    if (!this.withinRateLimit(connection)) {
      socket.close(CHAT_CLOSE.rateLimited, 'rate-limited');
      return;
    }

    const request = parseJoin(payload);

    if (!request) {
      send(socket, { type: 'error', code: 'BAD_REQUEST', message: 'join needs a broadcastId.' });
      return;
    }

    if (connection.rooms.size >= MAX_ROOMS) {
      send(socket, { type: 'error', code: 'TOO_MANY_ROOMS', message: 'Room limit reached.' });
      return;
    }

    if (!connection.user.permissions.includes('live:read')) {
      send(socket, { type: 'error', code: 'AUTH_FORBIDDEN', message: 'Missing live:read.' });
      return;
    }

    try {
      const page = await this.chat.history(request.broadcastId, request.afterSequence ?? 0, 50);

      connection.rooms.add(request.broadcastId);

      for (const message of page.messages) {
        send(socket, { type: 'message', message });
      }

      send(socket, {
        type: 'joined',
        broadcastId: request.broadcastId,
        replayed: page.messages.length,
        // Non-null means there is more history than one page; the client fetches
        // the rest over HTTP rather than expecting it here.
        nextCursor: page.nextCursor,
        latestSequence: page.latestSequence,
      });
    } catch {
      // A missing broadcast is the only failure history can produce, and it is
      // reported without confirming whether the id exists.
      send(socket, { type: 'error', code: 'BROADCAST_NOT_FOUND', message: 'Broadcast not found.' });
    }
  }

  @SubscribeMessage('leave')
  handleLeave(socket: ChatSocketLike, payload: unknown): void {
    const connection = this.connections.get(socket);
    const request = parseJoin(payload);

    if (connection && request) connection.rooms.delete(request.broadcastId);
  }

  @SubscribeMessage('ping')
  handlePing(socket: ChatSocketLike): void {
    send(socket, { type: 'pong', at: Date.now() });
  }

  /** Same slow-consumer policy as the topology gateway, and for the same reason. */
  private fanOut(broadcastId: string, event: ChatEvent): void {
    const message = event.kind === 'message' ? { type: 'message', message: event.message } : { type: 'deleted', ...event };

    for (const connection of this.connections.values()) {
      if (!connection.rooms.has(broadcastId)) continue;

      if ((connection.socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
        this.logger.warn('chat_slow_consumer_dropped', {
          connectionId: connection.id,
          broadcastId,
          bufferedBytes: connection.socket.bufferedAmount,
        });
        connection.socket.close(CHAT_CLOSE.slowConsumer, 'slow-consumer');
        this.connections.delete(connection.socket);
        continue;
      }

      send(connection.socket, message);
    }
  }

  private withinRateLimit(connection: ChatConnection): boolean {
    const now = Date.now();
    connection.messageTimes = connection.messageTimes.filter((at) => now - at < RATE_WINDOW_MS);
    connection.messageTimes.push(now);

    return connection.messageTimes.length <= MAX_MESSAGES_PER_WINDOW;
  }

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

function send(socket: ChatSocketLike, message: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Already closed. The disconnect handler cleans up.
  }
}

/** Same handshake trade as the topology gateway — see the note there. */
function readToken(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token');

  return token && token.length > 0 ? token : null;
}

function parseJoin(payload: unknown): { broadcastId: string; afterSequence?: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const { broadcastId, afterSequence } = payload as { broadcastId?: unknown; afterSequence?: unknown };

  if (typeof broadcastId !== 'string' || broadcastId === '') return null;
  if (afterSequence === undefined) return { broadcastId };

  if (typeof afterSequence !== 'number' || !Number.isInteger(afterSequence) || afterSequence < 0) return null;

  return { broadcastId, afterSequence };
}
