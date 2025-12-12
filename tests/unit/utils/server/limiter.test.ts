import { jest } from '@jest/globals';
import { createLimiter } from '@/utils/server/internal/transport/limiter.ts';

describe('utils/server createLimiter', () => {
  test('allows immediate acquire under maxConcurrent', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 50 });
    const release = await limiter.acquire();
    expect(typeof release).toBe('function');
    release();
  });

  test('release is idempotent', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 0, queueTimeoutMs: 0 });
    const release = await limiter.acquire();
    release();
    release();
    const release2 = await limiter.acquire();
    release2();
  });

  test('defaults queue options when omitted', async () => {
    const limiter = createLimiter({ maxConcurrent: 1 } as any);
    const release1 = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ statusCode: 503, code: 'server_busy' });
    release1();
  });

  test('treats non-finite maxConcurrent as unlimited', async () => {
    const limiter = createLimiter({ maxConcurrent: Infinity as any, maxQueueSize: 0, queueTimeoutMs: 0 });
    const release = await limiter.acquire();
    expect(typeof release).toBe('function');
    release();
  });

  test('queues when saturated and resolves FIFO', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 2, queueTimeoutMs: 100 });
    const release1 = await limiter.acquire();

    let acquiredSecond = false;
    const second = limiter.acquire().then((release) => {
      acquiredSecond = true;
      return release;
    });

    await new Promise(r => setTimeout(r, 10));
    expect(acquiredSecond).toBe(false);

    release1();
    const release2 = await second;
    expect(acquiredSecond).toBe(true);
    release2();
  });

  test('rejects when queue is full', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 0, queueTimeoutMs: 50 });
    const release1 = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ statusCode: 503 });
    release1();
  });

  test('rejects when queue wait exceeds timeout', async () => {
    jest.useFakeTimers();
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 10 });
    const release1 = await limiter.acquire();

    const pending = limiter.acquire();
    jest.advanceTimersByTime(20);
    await expect(pending).rejects.toMatchObject({ statusCode: 503, code: 'queue_timeout' });
    release1();
    jest.useRealTimers();
  });

  test('rejects immediately when signal already aborted', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 1, queueTimeoutMs: 50 });
    const release1 = await limiter.acquire();
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({ statusCode: 499, code: 'client_aborted' });
    release1();
  });

  test('skips canceled queue items on release', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueSize: 2, queueTimeoutMs: 50 });
    const release1 = await limiter.acquire();

    const controller = new AbortController();
    const secondPromise = limiter.acquire(controller.signal);
    controller.abort();
    await expect(secondPromise).rejects.toMatchObject({ code: 'client_aborted' });

    let thirdAcquired = false;
    const thirdPromise = limiter.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });

    release1();
    const release3 = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    release3();
  });
});
