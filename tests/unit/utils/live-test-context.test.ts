import { describe, expect, test, afterEach } from '@jest/globals';
import { getLiveTestContext, runWithLiveTestContext } from '@/utils/testing/live-test-context.ts';

const originalLive = process.env.LLM_LIVE;

afterEach(() => {
  if (originalLive === undefined) {
    delete process.env.LLM_LIVE;
  } else {
    process.env.LLM_LIVE = originalLive;
  }
});

describe('utils/testing/live-test-context', () => {
  test('is a no-op when LLM_LIVE is not set', async () => {
    delete process.env.LLM_LIVE;
    const ctx = { correlationId: 'c1', testFile: 't1' };

    const result = await runWithLiveTestContext(ctx, async () => {
      expect(getLiveTestContext()).toBeUndefined();
      return 123;
    });

    expect(result).toBe(123);
    expect(getLiveTestContext()).toBeUndefined();
  });

  test('stores and retrieves context when LLM_LIVE=1', async () => {
    process.env.LLM_LIVE = '1';
    const ctx = { correlationId: 'c2', testFile: 't2', testName: 'n2' };

    const result = await runWithLiveTestContext(ctx, async () => {
      expect(getLiveTestContext()).toEqual(ctx);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(getLiveTestContext()).toBeUndefined();
  });
});

