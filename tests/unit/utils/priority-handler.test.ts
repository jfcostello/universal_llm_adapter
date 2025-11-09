import { jest } from '@jest/globals';
import { withRetries } from '@/utils/retry/priority-handler.ts';

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
});
