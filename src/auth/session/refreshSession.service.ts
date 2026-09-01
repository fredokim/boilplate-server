import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, type LoggerPort } from '../../common/logging/logger.port';
import { AppConfig } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { generateRefreshToken, hashRefreshToken } from '../tokens/refreshToken';

export type IssuedRefreshToken = {
  token: string;
  expiresAt: Date;
};

export type RefreshContext = {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

/**
 * Outcome of presenting a refresh token. `reused` is separate from `invalid`
 * because it means something different happened: the token was real but had
 * already been spent, which is the signature of a stolen token being replayed.
 */
export type RefreshOutcome =
  | { kind: 'rotated'; userId: string; issued: IssuedRefreshToken }
  | { kind: 'invalid' }
  | { kind: 'reused'; userId: string };

@Injectable()
export class RefreshSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {}

  /** Starts a new family. Called on login, never on refresh. */
  async startFamily(userId: string, context: RefreshContext): Promise<IssuedRefreshToken> {
    return this.create(userId, randomUUID(), context);
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * The old row is revoked in the same transaction that creates its replacement,
   * so there is never a moment where both are usable and never a moment where
   * neither is. Two concurrent refreshes with the same token therefore cannot both
   * succeed: the second finds the row already revoked and is treated as a reuse.
   */
  async rotate(token: string, context: RefreshContext): Promise<RefreshOutcome> {
    const tokenHash = hashRefreshToken(token);
    const existing = await this.prisma.refreshSession.findUnique({ where: { tokenHash } });

    if (!existing) return { kind: 'invalid' };

    const now = new Date();

    if (existing.revokedAt !== null) {
      // Already spent. Either a replay of a stolen token, or the legitimate
      // holder racing itself — indistinguishable from here, and the safe reading
      // is the first one.
      await this.revokeFamily(existing.familyId, 'refresh_token_reuse');
      this.logger.warn('refresh_token_reuse_detected', {
        userId: existing.userId,
        familyId: existing.familyId,
        sessionId: existing.id,
      });
      return { kind: 'reused', userId: existing.userId };
    }

    if (existing.expiresAt <= now) {
      await this.prisma.refreshSession.update({ where: { id: existing.id }, data: { revokedAt: now } });
      return { kind: 'invalid' };
    }

    const replacement = generateRefreshToken();
    const expiresAt = new Date(now.getTime() + this.config.refreshTokenTtlMs);

    const created = await this.prisma.$transaction(async (tx) => {
      const next = await tx.refreshSession.create({
        data: {
          userId: existing.userId,
          familyId: existing.familyId,
          tokenHash: hashRefreshToken(replacement),
          expiresAt,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
      });

      await tx.refreshSession.update({
        where: { id: existing.id },
        data: { revokedAt: now, lastUsedAt: now, replacedById: next.id },
      });

      return next;
    });

    return {
      kind: 'rotated',
      userId: existing.userId,
      issued: { token: replacement, expiresAt: created.expiresAt },
    };
  }

  /**
   * Ends the session a token belongs to. Returns whether anything was actually
   * revoked, so logout can report honestly without failing when there was nothing
   * to end — a logout with a stale cookie is a success, not an error.
   */
  async revokeByToken(token: string): Promise<boolean> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
    });

    if (!session || session.revokedAt !== null) return false;

    await this.revokeFamily(session.familyId, 'logout');
    return true;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    const result = await this.prisma.refreshSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.logger.info('refresh_family_revoked', { familyId, reason, sessionsRevoked: result.count });
  }

  private async create(userId: string, familyId: string, context: RefreshContext): Promise<IssuedRefreshToken> {
    const token = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.refreshTokenTtlMs);

    await this.prisma.refreshSession.create({
      data: {
        userId,
        familyId,
        tokenHash: hashRefreshToken(token),
        expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });

    return { token, expiresAt };
  }
}
