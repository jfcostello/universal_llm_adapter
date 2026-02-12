import { jest } from '@jest/globals';

describe('core/logging buffered-append', () => {
  test('scheduleFlush swallows async flush rejections', async () => {
    const { createBufferedAppendState, scheduleFlush } = await import('@/modules/logging/internal/buffered-append.ts');

    const state = createBufferedAppendState();
    const flush = jest.fn(() => Promise.reject(new Error('boom')));

    scheduleFlush(state, flush);

    await new Promise<void>(resolve => setImmediate(resolve));

    expect(flush).toHaveBeenCalledTimes(1);
    expect(state.flushScheduled).toBe(false);
  });
});

