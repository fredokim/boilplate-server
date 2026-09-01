export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Operation timed out after ${String(timeoutMs)}ms.`);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with `TimeoutError` if `operation` has not settled within `timeoutMs`.
 *
 * Health checks are the motivating case. A driver's own connect timeout is
 * tuned for a query that should eventually succeed — Prisma's is roughly four
 * seconds — but a readiness probe is usually given one to three. Left unbounded
 * the probe is killed by its caller before it can answer, so an orchestrator
 * sees a timeout rather than the 503 that says which dependency is down.
 *
 * The timer is always cleared, including on the success path: an unreferenced
 * pending timer would hold the event loop open and delay shutdown.
 */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
