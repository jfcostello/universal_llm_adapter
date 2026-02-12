import { jest } from '@jest/globals';
import { withRetries } from '@/modules/retry/index.ts';

describe('utils/retry/priority-handler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('uses default retry policy when configuration omitted', async () => {
    const fn = jest.fn().mockResolvedValue('immediate-success');

    const result = await withRetries([
      {
        provider: 'test',
        model: 'model',
        fn
      }
    ]);

    expect(result).toBe('immediate-success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries normal failures with exponential backoff', async () => {
    jest.useFakeTimers();

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockResolvedValueOnce('success');

    const logger = { warning: jest.fn() } as any;

    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 3, baseDelayMs: 100, multiplier: 2 },
      logger
    );

    await jest.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('Provider attempt failed'),
      expect.objectContaining({ retryNumber: 1, rateLimited: false })
    );
  });

  test('applies rate limit retry schedule', async () => {
    jest.useFakeTimers();

    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate-limit'), { isRateLimit: true }))
      .mockResolvedValueOnce('ok');

    const logger = { warning: jest.fn() } as any;
    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 2, baseDelayMs: 10, multiplier: 2, rateLimitDelays: [50] },
      logger
    );

    await jest.advanceTimersByTimeAsync(50000);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger.warning).toHaveBeenCalled();
  });

  test('throws last error when all retries exhausted', async () => {
    jest.useFakeTimers();

    const fn = jest.fn().mockRejectedValue(new Error('boom'));

    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 2, baseDelayMs: 1, multiplier: 2 }
    );

    const expectation = expect(promise).rejects.toThrow('boom');
    await jest.runAllTimersAsync();
    await expectation;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('logs when rate limit retries exhausted', async () => {
    const fn = jest.fn().mockImplementation(async () => {
      throw Object.assign(new Error('rate-limit'), { isRateLimit: true });
    });
    const logger = { warning: jest.fn() } as any;

    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 1, baseDelayMs: 10, multiplier: 2, rateLimitDelays: [] },
      logger
    );

    await expect(promise).rejects.toThrow('rate-limit');
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('rate limit retries exhausted'),
      expect.any(Object)
    );
  });

  test('logs when standard retries exhausted', async () => {
    jest.useFakeTimers();

    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const logger = { warning: jest.fn() } as any;

    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 1, baseDelayMs: 5, multiplier: 2 },
      logger
    );

    await expect(promise).rejects.toThrow('fail');
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('retries exhausted'),
      expect.any(Object)
    );
  });

  test('throws explicit error when sequence empty', async () => {
    await expect(withRetries([], { maxAttempts: 1, baseDelayMs: 1, multiplier: 2 })).rejects.toThrow(
      'Retry sequence empty'
    );
  });

  test('short-circuits before first attempt when signal is already aborted', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const ac = new AbortController();
    ac.abort();

    await expect(
      withRetries(
        [
          {
            provider: 'test',
            model: 'model',
            fn
          }
        ],
        { maxAttempts: 3, baseDelayMs: 100, multiplier: 2 },
        undefined,
        { signal: ac.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fn).not.toHaveBeenCalled();
  });

  test('short-circuits during retry backoff when signal aborts', async () => {
    jest.useFakeTimers();

    const fn = jest.fn().mockRejectedValue(new Error('temporary failure'));
    const ac = new AbortController();
    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 3, baseDelayMs: 100, multiplier: 2 },
      undefined,
      { signal: ac.signal }
    );

    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('uses custom abort-like predicate to stop retries immediately', async () => {
    const abortLikeError = Object.assign(new Error('request canceled'), { code: 'ERR_CANCELED' });
    const fn = jest.fn().mockRejectedValue(abortLikeError);

    await expect(
      withRetries(
        [
          {
            provider: 'test',
            model: 'model',
            fn
          }
        ],
        { maxAttempts: 3, baseDelayMs: 1, multiplier: 2 },
        undefined,
        { isAbortLikeError: (error) => String((error as any)?.code ?? '') === 'ERR_CANCELED' }
      )
    ).rejects.toBe(abortLikeError);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('default abort classifier short-circuits on AbortError name when signal is provided', async () => {
    const abortError = Object.assign(new Error('aborted by caller'), { name: 'AbortError' });
    const fn = jest.fn().mockRejectedValue(abortError);
    const ac = new AbortController();

    await expect(
      withRetries(
        [
          {
            provider: 'test',
            model: 'model',
            fn
          }
        ],
        { maxAttempts: 3, baseDelayMs: 1, multiplier: 2 },
        undefined,
        { signal: ac.signal }
      )
    ).rejects.toBe(abortError);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('default abort classifier short-circuits on abort error code when signal is provided', async () => {
    const abortError = { code: 'ABORT_ERR', message: 'aborted by signal' };
    const fn = jest.fn().mockRejectedValue(abortError);
    const ac = new AbortController();

    await expect(
      withRetries(
        [
          {
            provider: 'test',
            model: 'model',
            fn
          }
        ],
        { maxAttempts: 3, baseDelayMs: 1, multiplier: 2 },
        undefined,
        { signal: ac.signal }
      )
    ).rejects.toBe(abortError);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('keeps existing retry behavior when no signal and no custom abort predicate are provided', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('aborted by upstream'), { name: 'AbortError' }))
      .mockResolvedValueOnce('ok');

    const result = await withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 2, baseDelayMs: 1, multiplier: 2 }
    );

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('continues retrying when non-object errors are thrown while abort-aware options are enabled', async () => {
    const fn = jest.fn().mockRejectedValueOnce('temporary-string-error').mockResolvedValueOnce('ok');
    const ac = new AbortController();

    const result = await withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 2, baseDelayMs: 1, multiplier: 2 },
      undefined,
      { signal: ac.signal }
    );

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('default abort classifier handles missing message fields', async () => {
    const fn = jest.fn().mockRejectedValueOnce({ code: 'E_TEMP' }).mockResolvedValueOnce('ok');

    const result = await withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 2, baseDelayMs: 1, multiplier: 2 }
    );

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('aborts while waiting in rate-limit retry delay', async () => {
    jest.useFakeTimers();

    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('rate-limit'), { isRateLimit: true }));
    const ac = new AbortController();

    const promise = withRetries(
      [
        {
          provider: 'test',
          model: 'model',
          fn
        }
      ],
      { maxAttempts: 1, baseDelayMs: 1, multiplier: 2, rateLimitDelays: [30] },
      undefined,
      { signal: ac.signal }
    );

    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
