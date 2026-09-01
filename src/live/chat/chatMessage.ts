import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';

export const MAX_MESSAGE_LENGTH = 500;
export const MAX_HISTORY_PAGE = 100;

/**
 * True for characters that must never survive into a stored message.
 *
 * Expressed as code-point ranges rather than a regex literal on purpose: the
 * literals are invisible in an editor, survive copy-paste unpredictably, and make
 * the source file read as binary to tooling.
 *
 * - C0 and C1 controls, minus the tab and newline a person might legitimately type.
 * - The bidirectional overrides. `U+202E` and its neighbours re-order how text
 *   renders without changing what it contains, so a message can display as
 *   something quite different from what is stored — the same trick used to
 *   disguise file names.
 */
function isStrippedCharacter(codePoint: number): boolean {
  const isTabOrNewline = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
  if (isTabOrNewline) return false;

  const isC0 = codePoint <= 0x1f;
  const isC1 = codePoint >= 0x7f && codePoint <= 0x9f;
  const isBidiMark = codePoint === 0x200e || codePoint === 0x200f;
  const isBidiOverride = codePoint >= 0x202a && codePoint <= 0x202e;
  const isBidiIsolate = codePoint >= 0x2066 && codePoint <= 0x2069;

  return isC0 || isC1 || isBidiMark || isBidiOverride || isBidiIsolate;
}

function stripControlCharacters(value: string): string {
  let output = '';

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isStrippedCharacter(codePoint)) continue;
    output += character;
  }

  return output;
}

/**
 * Normalises and validates a chat message body.
 *
 * Three steps, and the order is deliberate.
 *
 * **NFC normalisation** first, because the same visible text has several
 * encodings and a length check before normalising measures the wrong string.
 * Two messages that look identical should also be identical.
 *
 * **Control characters** are stripped rather than rejected. They are invisible,
 * so a rejection would tell the sender their message is invalid while showing
 * them nothing wrong with it.
 *
 * **Length** is checked last, on the normalised and stripped string, so the limit
 * measures what will actually be stored.
 *
 * What this deliberately does not do is escape HTML. Escaping belongs at the
 * point of rendering, where the target syntax is known; doing it here would store
 * `&amp;` in the database and double-escape the moment anything else read it.
 */
export function normaliseMessageBody(raw: string): string {
  const normalised = stripControlCharacters(raw.normalize('NFC')).trim();

  if (normalised === '') {
    throw invalid('A message cannot be empty.');
  }

  if (normalised.length > MAX_MESSAGE_LENGTH) {
    throw invalid(`A message may be at most ${String(MAX_MESSAGE_LENGTH)} characters.`, {
      length: normalised.length,
      maxLength: MAX_MESSAGE_LENGTH,
    });
  }

  return normalised;
}

function invalid(message: string, details?: Record<string, unknown>): AppException {
  return new AppException({
    status: HttpStatus.BAD_REQUEST,
    code: ErrorCode.VALIDATION_ERROR,
    message,
    details,
  });
}

/**
 * Per-broadcast send throttling, held in this process.
 *
 * Same shape and same limitation as the login throttle: correct for one instance,
 * wrong for several, and the seam where a shared store goes. Keyed by broadcast
 * *and* user, so a busy room does not throttle a quiet one.
 */
export type ChatRateLimitConfig = {
  maxMessages: number;
  windowMs: number;
};

export const DEFAULT_CHAT_RATE_LIMIT: ChatRateLimitConfig = { maxMessages: 10, windowMs: 10_000 };

export class ChatRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly config: ChatRateLimitConfig = DEFAULT_CHAT_RATE_LIMIT) {}

  /** Records an attempt and reports whether it was within budget. */
  take(broadcastId: string, userId: string): boolean {
    const key = `${broadcastId}|${userId}`;
    const now = Date.now();

    const recent = (this.windows.get(key) ?? []).filter((at) => now - at < this.config.windowMs);

    if (recent.length >= this.config.maxMessages) {
      // The refused attempt is not recorded. Counting it would let a throttled
      // sender extend their own lockout by retrying.
      this.windows.set(key, recent);
      return false;
    }

    recent.push(now);
    this.windows.set(key, recent);
    this.sweep(now);

    return true;
  }

  /**
   * Without this the map grows once per distinct sender ever seen, and a
   * broadcast with a large audience would hold every one of them for the life of
   * the process.
   */
  private sweep(now: number): void {
    for (const [key, times] of this.windows) {
      if (times.every((at) => now - at >= this.config.windowMs)) this.windows.delete(key);
    }
  }
}
