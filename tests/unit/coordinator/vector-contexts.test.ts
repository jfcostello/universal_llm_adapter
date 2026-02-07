import { describe, expect, test } from '@jest/globals';

import {
  hasToolVectorContexts,
  resolveAutoVectorContexts,
  resolveVectorContexts,
  resolveVectorRequestPolicy,
  withTimeout
} from '@/modules/llm/internal/llm-coordinator/internal/vector-contexts.ts';

describe('coordinator/vector-contexts helpers', () => {
  test('resolveVectorContexts filters invalid entries and keeps valid contexts', () => {
    const resolved = resolveVectorContexts({
      vectorContexts: [
        null,
        123,
        {},
        { stores: [] },
        { stores: ['memory'], mode: 'auto' }
      ]
    } as any);

    expect(resolved).toEqual([{ stores: ['memory'], mode: 'auto' }]);
  });

  test('resolveVectorRequestPolicy clamps values and falls back for non-finite values', () => {
    const policy = resolveVectorRequestPolicy({
      vectorRequestPolicy: {
        maxAutoContexts: 9999,
        perContextTimeoutMs: Number.POSITIVE_INFINITY,
        totalAutoBudgetMs: 1,
        maxInjectedPayloadBytes: -1
      }
    } as any);

    expect(policy.maxAutoContexts).toBe(20);
    // Infinity falls back to default, then min/max bounds apply inside helper.
    expect(policy.perContextTimeoutMs).toBeGreaterThanOrEqual(50);
    expect(policy.totalAutoBudgetMs).toBe(50);
    expect(policy.maxInjectedPayloadBytes).toBe(64);
  });

  test('resolveAutoVectorContexts honors maxAutoContexts including zero', () => {
    const contexts = [
      { stores: ['s1'], mode: 'auto' },
      { stores: ['s2'], mode: 'both' },
      { stores: ['s3'], mode: 'tool' }
    ] as any[];

    expect(resolveAutoVectorContexts(contexts as any, { maxAutoContexts: 0 } as any)).toEqual([]);
    expect(resolveAutoVectorContexts(contexts as any, { maxAutoContexts: 1 } as any)).toEqual([
      { stores: ['s1'], mode: 'auto' }
    ]);
  });

  test('hasToolVectorContexts detects tool and both modes only', () => {
    expect(hasToolVectorContexts([{ stores: ['s1'], mode: 'auto' }] as any)).toBe(false);
    expect(hasToolVectorContexts([{ stores: ['s1'], mode: 'both' }] as any)).toBe(true);
  });

  test('withTimeout returns original promise for non-positive/non-finite timeout and times out otherwise', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 0, 'noop')).resolves.toBe('ok');
    await expect(withTimeout(Promise.resolve('still-ok'), Number.POSITIVE_INFINITY, 'noop')).resolves.toBe('still-ok');
    await expect(withTimeout(new Promise(() => {}), 1, 'vector context injection')).rejects.toThrow(
      'vector context injection timed out after 1ms'
    );
  });
});
