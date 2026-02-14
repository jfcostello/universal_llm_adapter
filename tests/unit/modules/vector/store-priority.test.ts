import { describe, expect, test } from '@jest/globals';

import type { VectorContextConfig } from '@/kernel/index.ts';
import {
  isCompleteVectorQueryResponse,
  resolveStorePriorityChain
} from '@/modules/vector/internal/store-priority/index.ts';

describe('modules/vector/store-priority', () => {
  test('resolveStorePriorityChain returns implicit single-attempt chain when storePriority is absent', () => {
    const config: VectorContextConfig = {
      stores: ['docs'],
      mode: 'auto'
    };

    const resolved = resolveStorePriorityChain(config, 'docs');

    expect(resolved.fallbackOnEmpty).toBe(false);
    expect(resolved.attempts).toEqual([{ store: 'docs' }]);
  });

  test('resolveStorePriorityChain resolves explicit attempts and fallbackOnEmpty override', () => {
    const config: VectorContextConfig = {
      stores: ['docs'],
      mode: 'tool',
      storePriority: {
        docs: {
          fallbackOnEmpty: true,
          attempts: [
            {
              store: 'docs-primary',
              collection: 'collection-a',
              embeddingPriority: [{ provider: 'embed-a', model: 'model-a' }]
            },
            {
              store: 'docs-secondary',
              collection: 'collection-b',
              embeddingPriority: [{ provider: 'embed-b', model: 'model-b' }]
            }
          ]
        }
      }
    };

    const resolved = resolveStorePriorityChain(config, 'docs');

    expect(resolved.fallbackOnEmpty).toBe(true);
    expect(resolved.attempts).toHaveLength(2);
    expect(resolved.attempts[0].store).toBe('docs-primary');
    expect(resolved.attempts[1].collection).toBe('collection-b');
  });

  test('resolveStorePriorityChain throws config_error when explicit attempts are empty', () => {
    const config: VectorContextConfig = {
      stores: ['docs'],
      mode: 'auto',
      storePriority: {
        docs: {
          attempts: []
        }
      }
    };

    expect(() => resolveStorePriorityChain(config, 'docs')).toThrow(/storePriority/i);
  });

  test('resolveStorePriorityChain throws config_error when attempt store is blank', () => {
    const config: VectorContextConfig = {
      stores: ['docs'],
      mode: 'auto',
      storePriority: {
        docs: {
          attempts: [{ store: '   ' as any }]
        }
      }
    };

    expect(() => resolveStorePriorityChain(config, 'docs')).toThrow(/storePriority/i);
  });

  test('resolveStorePriorityChain throws config_error when attempt entry is undefined', () => {
    const config: VectorContextConfig = {
      stores: ['docs'],
      mode: 'auto',
      storePriority: {
        docs: {
          attempts: [undefined as any]
        }
      }
    };

    expect(() => resolveStorePriorityChain(config, 'docs')).toThrow(/storePriority/i);
  });

  test('isCompleteVectorQueryResponse treats arrays as complete responses', () => {
    expect(isCompleteVectorQueryResponse([])).toBe(true);
    expect(isCompleteVectorQueryResponse([{ id: 'a', score: 0.5 }])).toBe(true);
  });

  test('isCompleteVectorQueryResponse rejects non-array responses', () => {
    expect(isCompleteVectorQueryResponse(null)).toBe(false);
    expect(isCompleteVectorQueryResponse(undefined)).toBe(false);
    expect(isCompleteVectorQueryResponse({ results: [] })).toBe(false);
    expect(isCompleteVectorQueryResponse('invalid')).toBe(false);
  });
});
