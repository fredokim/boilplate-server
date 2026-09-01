import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app.config';
import type { LoginAttempts } from './loginAttempts.port';

type Entry = { count: number; expiresAt: number };

/**
 * A fixed window counter held in this process.
 *
 * Two properties are worth stating plainly. It is per-process, so it does not
 * survive a restart and does not coordinate across instances — see the note on
 * the port. And it is a fixed window rather than a sliding one, so an attacker
 * who times requests around the boundary gets up to twice the budget in a short
 * burst. Both are acceptable for slowing down credential stuffing on a single
 * node; neither would be acceptable as the only control in production.
 *
 * Expired entries are swept on write rather than by a timer, so an idle process
 * holds no interval open and shutdown is not delayed.
 */
@Injectable()
export class MemoryLoginAttempts implements LoginAttempts {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly config: AppConfig) {}

  isBlocked(key: string): Promise<boolean> {
    const entry = this.entries.get(key);

    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(false);
    }

    return Promise.resolve(entry.count >= this.config.maxLoginAttempts);
  }

  recordFailure(key: string): Promise<void> {
    const now = Date.now();
    this.sweep(now);

    const entry = this.entries.get(key);

    if (!entry || entry.expiresAt <= now) {
      this.entries.set(key, { count: 1, expiresAt: now + this.config.loginWindowMs });
      return Promise.resolve();
    }

    entry.count += 1;
    return Promise.resolve();
  }

  clear(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  /**
   * Without this the map grows once per distinct key seen — and the key includes
   * the client address, so a spray across many addresses would be an unbounded
   * allocation driven by an unauthenticated caller.
   */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
