import { Algorithm, hash, parseOptions, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';
import type { PasswordHasher } from './passwordHasher.port';

/**
 * Argon2id parameters. These are the OWASP baseline: 19 MiB of memory, two
 * passes, one lane.
 *
 * The memory cost is the point. Argon2id is memory-hard, so an attacker with
 * GPUs cannot trade silicon for speed the way they can against a hash that only
 * costs CPU time. Lowering `memoryCost` to make login feel faster removes most
 * of the protection while barely changing the response time a person notices.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * `@node-rs/argon2` rather than the `argon2` package: it ships prebuilt binaries
 * for every platform this project targets, so `npm install` needs no C toolchain
 * and no node-gyp. Verified working on this machine before it was adopted.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  hash(plaintext: string): Promise<string> {
    return hash(plaintext, OPTIONS);
  }

  async verify(passwordHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plaintext, OPTIONS);
    } catch {
      // A stored value that is not a parseable Argon2 hash — corrupted, or
      // written by an older scheme. It is not a match, and it is not a reason to
      // return a 500 to someone typing their password.
      return false;
    }
  }

  /**
   * `@node-rs/argon2` exposes no `needsRehash`, so the comparison is made here
   * against the parameters encoded in the PHC string.
   *
   * Only weaker-than-current counts. A hash written with *higher* costs — someone
   * lowered the settings, or an older account was created on a bigger machine —
   * is left alone: downgrading it would be the one thing this method must never
   * do silently.
   */
  needsRehash(passwordHash: string): boolean {
    try {
      const parsed = parseOptions(passwordHash);

      return (
        parsed.algorithm !== OPTIONS.algorithm ||
        parsed.memoryCost < OPTIONS.memoryCost ||
        parsed.timeCost < OPTIONS.timeCost ||
        parsed.parallelism < OPTIONS.parallelism
      );
    } catch {
      // Unparseable means it certainly does not meet the current parameters.
      return true;
    }
  }
}
