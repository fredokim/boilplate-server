import { TimeoutError, withTimeout } from './withTimeout';

describe('withTimeout', () => {
  it('returns the value when the operation settles in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 50)).resolves.toBe('done');
  });

  it('rejects with TimeoutError when the operation hangs', async () => {
    const neverSettles = new Promise<string>(() => undefined);

    await expect(withTimeout(neverSettles, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('names the budget in the message so a log says what was exceeded', async () => {
    const neverSettles = new Promise<string>(() => undefined);

    await expect(withTimeout(neverSettles, 10)).rejects.toThrow('timed out after 10ms');
  });

  it('propagates the original rejection rather than masking it as a timeout', async () => {
    const failure = Promise.reject(new Error('connection refused'));

    await expect(withTimeout(failure, 50)).rejects.toThrow('connection refused');
  });

  /**
   * A leaked timer keeps the event loop alive and delays process shutdown, which
   * is exactly what `enableShutdownHooks` is there to avoid.
   */
  it('clears its timer on the success path', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.resolve('done'), 10_000);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
