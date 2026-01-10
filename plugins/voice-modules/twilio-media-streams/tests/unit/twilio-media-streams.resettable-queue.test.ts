import { jest } from '@jest/globals';

import { ResettableQueue } from '@/plugins/voice-modules/twilio-media-streams/internal/resettable-queue.ts';

describe('plugins/voice-modules/twilio-media-streams: ResettableQueue', () => {
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
});
