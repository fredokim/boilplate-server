import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/contracts/errorCode';
import { AppException } from '../common/exceptions/appException';
import { LOGGER, type LoggerPort } from '../common/logging/logger.port';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticatedUser';
import { assertTransition, type BroadcastStatus, isBroadcastStatus } from './broadcastState';

/** Short enough that a leaked URL stops working before it is useful. */
const PLAYBACK_SESSION_TTL_MS = 5 * 60 * 1_000;

export type BroadcastView = {
  id: string;
  title: string;
  description: string | null;
  status: BroadcastStatus;
  sourceType: 'hls' | 'progressive';
  isLive: boolean;
  dvrEnabled: boolean;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type PlaybackGrant = {
  sessionId: string;
  source: { kind: 'hls' | 'progressive'; src: string; lowLatency?: boolean };
  isLive: boolean;
  dvrEnabled: boolean;
  expiresAt: string;
};

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {}

  /**
   * Broadcast metadata, deliberately **without** the manifest URL.
   *
   * The URL is a capability: anyone holding it can play the stream. Handing it
   * out with the metadata would make it permanent and unrevocable, so it is only
   * ever issued through a playback session that expires.
   */
  async findBroadcast(broadcastId: string): Promise<BroadcastView> {
    const row = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });

    if (!row) throw broadcastNotFound();

    return toView(row);
  }

  async listBroadcasts(): Promise<BroadcastView[]> {
    const rows = await this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });

    return rows.map(toView);
  }

  /**
   * Issues a short-lived grant to play one broadcast.
   *
   * Only a live broadcast is playable. A scheduled one has no stream yet and an
   * ended one has no stream any more; issuing a URL for either would produce a
   * player that fails with a manifest error rather than a clear reason.
   */
  async createPlaybackSession(broadcastId: string, user: AuthenticatedUser): Promise<PlaybackGrant> {
    const row = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });

    if (!row) throw broadcastNotFound();

    const status = toStatus(row.status);

    if (status !== 'live') {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ErrorCode.BROADCAST_NOT_PLAYABLE,
        message: 'This broadcast is not currently live.',
        details: { status },
      });
    }

    const expiresAt = new Date(Date.now() + PLAYBACK_SESSION_TTL_MS);

    const session = await this.prisma.playbackSession.create({
      data: { broadcastId, userId: user.id, expiresAt },
    });

    // The session id and the expiry are logged; the manifest URL is not, and must
    // not be — an access log is exactly the kind of place a capability leaks from.
    this.logger.info('playback_session_issued', {
      broadcastId,
      userId: user.id,
      sessionId: session.id,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      sessionId: session.id,
      source: {
        kind: row.sourceType === 'progressive' ? 'progressive' : 'hls',
        src: row.manifestUrl,
        ...(row.sourceType === 'progressive' ? {} : { lowLatency: true }),
      },
      isLive: true,
      dvrEnabled: row.dvrEnabled,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Moves a broadcast through its lifecycle. Idempotent: asking for the status it
   * already has succeeds and changes nothing, so an operator double-click or a
   * retried request is not an error.
   */
  async transition(broadcastId: string, to: string, moderator: AuthenticatedUser): Promise<BroadcastView> {
    if (!isBroadcastStatus(to)) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.BROADCAST_INVALID_TRANSITION,
        message: 'Unknown broadcast status.',
        details: { received: to },
      });
    }

    const row = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (!row) throw broadcastNotFound();

    const from = toStatus(row.status);
    const { changed } = assertTransition(from, to);

    if (!changed) return toView(row);

    const now = new Date();
    const updated = await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: to,
        ...(to === 'live' ? { startedAt: now } : {}),
        ...(to === 'ended' ? { endedAt: now } : {}),
      },
    });

    this.logger.info('broadcast_transitioned', { broadcastId, from, to, moderatorId: moderator.id });

    return toView(updated);
  }
}

type BroadcastRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  sourceType: string;
  dvrEnabled: boolean;
  scheduledFor: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
};

function toStatus(value: string): BroadcastStatus {
  return isBroadcastStatus(value) ? value : 'scheduled';
}

function toView(row: BroadcastRow): BroadcastView {
  const status = toStatus(row.status);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status,
    sourceType: row.sourceType === 'progressive' ? 'progressive' : 'hls',
    // Derived from the stored status, never from the clock. See broadcastState.ts.
    isLive: status === 'live',
    dvrEnabled: row.dvrEnabled,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

export function broadcastNotFound(): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ErrorCode.BROADCAST_NOT_FOUND,
    message: 'Broadcast not found.',
  });
}
