import { jest } from '@jest/globals';

import { ResettableQueue } from '@/extensions/voice/modules/media-bridge/index.ts';

describe('extensions/voice/modules/media-bridge: ResettableQueue', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('clear() wakes a consumer waiting in next() without closing the queue', async () => {
    const q = new ResettableQueue<number>();
    const pending = q.next();

    q.clear();

    let resolved: any = undefined;
    pending.then(v => { resolved = v; }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBeTruthy();
    expect(resolved).toEqual({ value: null, generation: 1 });

    q.push(123);
    const after = await q.next();
    expect(after).toEqual({ value: 123, generation: 1 });
  });

  test('nextValue() ignores clear() wakeups and continues waiting', async () => {
    const q = new ResettableQueue<number>();
    const pending = q.nextValue();

    q.clear();
    q.push(123);

    await expect(pending).resolves.toBe(123);
  });

  test('close() wakes a consumer waiting in next() and terminates the iterator', async () => {
    const q = new ResettableQueue<number>();
    const pending = q.next();

    q.close();

    let resolved: any = undefined;
    pending.then(v => { resolved = v; }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBeNull();
  });

  test('compacts internal storage after large drains (covers maybeCompact)', async () => {
    const q = new ResettableQueue<number>();
    const total = 3000;

    for (let i = 0; i < total; i++) {
      q.push(i);
    }

    // Drain enough items to exceed the compaction threshold and also exceed half the queue length.
    for (let i = 0; i < 2000; i++) {
      const next = await q.next();
      expect(next?.value).toBe(i);
    }

    expect(q.size()).toBe(1000);

    // Still behaves as a FIFO after compaction.
    const next = await q.next();
    expect(next?.value).toBe(2000);
  });
});
