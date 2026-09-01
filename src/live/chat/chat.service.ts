import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { LOGGER, type LoggerPort } from '../../common/logging/logger.port';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedUser } from '../../auth/types/authenticatedUser';
import { chatAcceptsMessages, isBroadcastStatus } from '../broadcastState';
import { broadcastNotFound } from '../live.service';
import { ChatRateLimiter, MAX_HISTORY_PAGE, normaliseMessageBody } from './chatMessage';

/**
 * What goes over the wire. Matched to what the frontend chat store already
 * consumes: an id to dedupe on, a sequence to order on, a display name, and a
 * server timestamp.
 */
export type ChatMessageView = {
  id: string;
  clientMessageId: string;
  broadcastId: string;
  sequence: number;
  authorId: string;
  displayName: string;
  body: string;
  sentAt: string;
  deleted: boolean;
};

/**
 * A deletion, delivered as its own event rather than by removing the message.
 *
 * Clients that already received the message need to be told to drop it; a
 * tombstone is what makes them converge without refetching history.
 */
export type ChatTombstone = {
  kind: 'deleted';
  broadcastId: string;
  messageId: string;
  sequence: number;
  deletedAt: string;
};

export type ChatHistoryPage = {
  messages: ChatMessageView[];
  nextCursor: number | null;
  latestSequence: number;
};

@Injectable()
export class ChatService {
  private readonly rateLimiter = new ChatRateLimiter();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {}

  /**
   * Cursor pagination by sequence, not by offset.
   *
   * An offset shifts under a live chat — messages arrive between pages and rows
   * get skipped or repeated. A sequence cursor is stable no matter what happens
   * in between, and it is the same number a reconnecting client already holds.
   */
  async history(broadcastId: string, afterSequence: number, limit: number): Promise<ChatHistoryPage> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
      select: { chatSequence: true },
    });

    if (!broadcast) throw broadcastNotFound();

    const take = Math.min(Math.max(limit, 1), MAX_HISTORY_PAGE);

    const rows = await this.prisma.chatMessage.findMany({
      where: { broadcastId, sequence: { gt: afterSequence } },
      orderBy: { sequence: 'asc' },
      take,
      include: { author: { select: { name: true } } },
    });

    const messages = rows.map(toView);
    const last = messages.at(-1);

    return {
      messages,
      // Null when this page reached the end, so a client knows to stop rather
      // than poll for a page it already has.
      nextCursor: last && messages.length === take ? last.sequence : null,
      latestSequence: broadcast.chatSequence,
    };
  }

  /**
   * Stores a message and returns it.
   *
   * Three properties, in order of how easily they are lost:
   *
   * - **Idempotent.** The client supplies `clientMessageId`, unique per broadcast,
   *   so a retry after a timeout returns the message that was already stored
   *   rather than posting it twice.
   * - **Server-ordered.** The sequence and the timestamp are both allocated here.
   *   A client's clock is trivially wrong and trivially forged, and ordering
   *   depends on this.
   * - **Atomic.** The sequence increment and the insert are one transaction, so
   *   two senders cannot be handed the same number.
   */
  async send(
    broadcastId: string,
    user: AuthenticatedUser,
    clientMessageId: string,
    rawBody: string,
  ): Promise<{ message: ChatMessageView; duplicate: boolean }> {
    const broadcast = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (!broadcast) throw broadcastNotFound();

    const status = isBroadcastStatus(broadcast.status) ? broadcast.status : 'scheduled';

    if (!chatAcceptsMessages(status)) {
      // History stays readable after a broadcast ends; only writing closes.
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CHAT_CLOSED,
        message: 'Chat is closed for this broadcast.',
        details: { status },
      });
    }

    await this.assertNotMuted(broadcastId, user.id);

    // The idempotency check comes before the rate limit: a retry of a message
    // that was already stored must not be counted as a new send.
    const existing = await this.prisma.chatMessage.findUnique({
      where: { broadcastId_clientMessageId: { broadcastId, clientMessageId } },
      include: { author: { select: { name: true } } },
    });

    if (existing) return { message: toView(existing), duplicate: true };

    if (!this.rateLimiter.take(broadcastId, user.id)) {
      throw new AppException({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.CHAT_RATE_LIMITED,
        message: 'You are sending messages too quickly.',
      });
    }

    const body = normaliseMessageBody(rawBody);

    const stored = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.broadcast.update({
        where: { id: broadcastId },
        data: { chatSequence: { increment: 1 } },
        select: { chatSequence: true },
      });

      return tx.chatMessage.create({
        data: {
          broadcastId,
          authorId: user.id,
          clientMessageId,
          sequence: updated.chatSequence,
          body,
        },
        include: { author: { select: { name: true } } },
      });
    });

    // The body is never logged. A chat log in an access log is a privacy problem
    // and a compliance one.
    this.logger.debug('chat_message_stored', { broadcastId, sequence: stored.sequence, authorId: user.id });

    return { message: toView(stored), duplicate: false };
  }

  /**
   * Marks a message deleted without removing the row.
   *
   * The body is retained deliberately: a moderation action has to be auditable,
   * and "what was removed" is the part that matters. What clients see is the
   * tombstone.
   */
  async deleteMessage(
    broadcastId: string,
    messageId: string,
    moderator: AuthenticatedUser,
    reason?: string,
  ): Promise<ChatTombstone> {
    const message = await this.prisma.chatMessage.findUnique({ where: { id: messageId } });

    if (!message || message.broadcastId !== broadcastId) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'Message not found.',
      });
    }

    const deletedAt = message.deletedAt ?? new Date();

    if (!message.deletedAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.chatMessage.update({
          where: { id: messageId },
          data: { deletedAt, deletedBy: moderator.id },
        });

        await tx.chatModerationAction.create({
          data: {
            broadcastId,
            action: 'delete_message',
            moderatorId: moderator.id,
            targetId: messageId,
            reason: reason ?? null,
          },
        });
      });

      this.logger.info('chat_message_deleted', { broadcastId, messageId, moderatorId: moderator.id });
    }

    return {
      kind: 'deleted',
      broadcastId,
      messageId,
      sequence: message.sequence,
      deletedAt: deletedAt.toISOString(),
    };
  }

  async muteUser(
    broadcastId: string,
    targetId: string,
    moderator: AuthenticatedUser,
    durationMs: number | null,
    reason?: string,
  ): Promise<{ targetId: string; until: string | null }> {
    const expiresAt = durationMs === null ? null : new Date(Date.now() + durationMs);

    await this.prisma.chatModerationAction.create({
      data: {
        broadcastId,
        action: 'mute_user',
        moderatorId: moderator.id,
        targetId,
        reason: reason ?? null,
        expiresAt,
      },
    });

    this.logger.info('chat_user_muted', {
      broadcastId,
      targetId,
      moderatorId: moderator.id,
      until: expiresAt?.toISOString() ?? 'indefinite',
    });

    return { targetId, until: expiresAt?.toISOString() ?? null };
  }

  async unmuteUser(broadcastId: string, targetId: string, moderator: AuthenticatedUser): Promise<void> {
    // Recorded as its own action rather than by deleting the mute, so the history
    // of who did what survives.
    await this.prisma.chatModerationAction.create({
      data: { broadcastId, action: 'unmute_user', moderatorId: moderator.id, targetId },
    });

    this.logger.info('chat_user_unmuted', { broadcastId, targetId, moderatorId: moderator.id });
  }

  /**
   * A user is muted when their most recent mute/unmute action is a mute that has
   * not expired. Reading the latest action rather than counting them is what
   * makes unmute work without deleting history.
   */
  private async assertNotMuted(broadcastId: string, userId: string): Promise<void> {
    const latest = await this.prisma.chatModerationAction.findFirst({
      where: { broadcastId, targetId: userId, action: { in: ['mute_user', 'unmute_user'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (!latest || latest.action !== 'mute_user') return;
    if (latest.expiresAt && latest.expiresAt <= new Date()) return;

    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ErrorCode.CHAT_USER_MUTED,
      message: 'You are muted in this chat.',
      details: { until: latest.expiresAt?.toISOString() ?? null },
    });
  }
}

function toView(row: {
  id: string;
  clientMessageId: string;
  broadcastId: string;
  sequence: number;
  authorId: string;
  body: string;
  sentAt: Date;
  deletedAt: Date | null;
  author?: { name: string } | null;
}): ChatMessageView {
  const deleted = row.deletedAt !== null;

  return {
    id: row.id,
    clientMessageId: row.clientMessageId,
    broadcastId: row.broadcastId,
    sequence: row.sequence,
    authorId: row.authorId,
    displayName: row.author?.name ?? 'Unknown',
    // A deleted message keeps its row for audit but must not carry its body to a
    // client — that is the whole point of removing it.
    body: deleted ? '' : row.body,
    sentAt: row.sentAt.toISOString(),
    deleted,
  };
}
