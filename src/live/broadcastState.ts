import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../common/contracts/errorCode';
import { AppException } from '../common/exceptions/appException';

/**
 * Broadcast lifecycle.
 *
 * The status is authoritative and is never inferred from timestamps. A broadcast
 * that started late or overran would otherwise be reported wrongly by the clock,
 * and "is this live?" is a question the player must not get a guess at.
 */
export const BROADCAST_STATUSES = ['scheduled', 'live', 'ended'] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/**
 * Allowed transitions.
 *
 * `ended` is terminal: a broadcast that finished cannot go back to live, because
 * every client that saw it end has already torn down its player and its chat.
 * Restarting is a new broadcast, which is also what a viewer would expect.
 */
const ALLOWED: Record<BroadcastStatus, BroadcastStatus[]> = {
  scheduled: ['live', 'ended'],
  live: ['ended'],
  ended: [],
};

export function isBroadcastStatus(value: unknown): value is BroadcastStatus {
  return typeof value === 'string' && (BROADCAST_STATUSES as readonly string[]).includes(value);
}

export type TransitionOutcome = { changed: boolean };

/**
 * Checks a transition, treating a no-op as success.
 *
 * Idempotence is the point: an operator clicking "go live" twice, or a retried
 * request, must not fail. Only a move the machine forbids is an error.
 */
export function assertTransition(from: BroadcastStatus, to: BroadcastStatus): TransitionOutcome {
  if (from === to) return { changed: false };

  if (!ALLOWED[from].includes(to)) {
    throw new AppException({
      status: HttpStatus.CONFLICT,
      code: ErrorCode.BROADCAST_INVALID_TRANSITION,
      message: `A broadcast cannot go from ${from} to ${to}.`,
      details: { from, to, allowed: ALLOWED[from] },
    });
  }

  return { changed: true };
}

/** Chat is writable only while a broadcast is live. History stays readable after. */
export function chatAcceptsMessages(status: BroadcastStatus): boolean {
  return status === 'live';
}
