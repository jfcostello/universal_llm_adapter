import { AsyncQueue } from '@/modules/kernel/index.ts';

describe('kernel/async-queue', () => {
  test('push/iterate yields items and close ends iteration', async () => {
    const q = new AsyncQueue<number>();

    // Cover the "push into items" branch (no waiting resolvers yet).
    q.push(1);

    const seen: number[] = [];
    const consumer = (async () => {
      for await (const v of q.iterate()) {
        seen.push(v);
        if (seen.length === 2) break;
      }
    })();

    // Cover the "push resolves waiting next()" branch.
    q.push(2);

    await consumer;
    expect(seen).toEqual([1, 2]);

    q.close();
    const done = await q.next();
    expect(done.done).toBe(true);
  });

  test('push after close is ignored and close resolves pending next()', async () => {
    const q = new AsyncQueue<number>();
    const pending = q.next();

    q.close();
    q.push(123);

    const res = await pending;
    expect(res.done).toBe(true);
  });
});
