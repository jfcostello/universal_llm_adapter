import { describe, expect, test } from '@jest/globals';

import {
  closeVectorRuntime,
  ensureVectorRuntime
} from '@/modules/tools/internal/tool-coordinator/internal/vector-runtime.ts';
import {
  computeVectorSearchState,
  getVectorSearchEntryForToolName,
  translateVectorSearchArgs
} from '@/modules/tools/internal/tool-coordinator/internal/vector-search.ts';

describe('utils/tool-coordinator internal helpers', () => {
  test('ensureVectorRuntime lazily initializes managers', async () => {
    const state: any = {};
    const runtime = await ensureVectorRuntime(state, {} as any);
    expect(runtime.embeddingManager).toBeDefined();
    expect(runtime.vectorManager).toBeDefined();
  });

  test('closeVectorRuntime swallows closeAll failures', async () => {
    const state: any = {
      vectorManager: {
        closeAll: async () => {
          throw new Error('close failure');
        }
      }
    };

    await expect(closeVectorRuntime(state)).resolves.toBeUndefined();
  });

  test('computeVectorSearchState skips invalid configs and retains valid entries', () => {
    const byToolName = computeVectorSearchState(
      [null as any, { stores: ['memory'], mode: 'tool', toolName: 'semantic_search' } as any],
      { semantic_search: { k: 'topK' } }
    );

    expect(byToolName.has('semantic_search')).toBe(true);
    expect(byToolName.get('semantic_search')?.aliasMap).toEqual({ k: 'topK' });
  });

  test('getVectorSearchEntryForToolName only returns tool/both entries', () => {
    const map = computeVectorSearchState([
      { stores: ['memory'], mode: 'auto', toolName: 'auto_search' } as any,
      { stores: ['memory'], mode: 'both', toolName: 'both_search' } as any
    ]);

    expect(getVectorSearchEntryForToolName({ toolName: 'auto_search', byToolName: map })).toBeUndefined();
    expect(getVectorSearchEntryForToolName({ toolName: 'both_search', byToolName: map })).toBeDefined();
  });

  test('translateVectorSearchArgs returns original args without alias map and remaps with aliases', () => {
    const args = { q: 'query', k: 3 };
    expect(translateVectorSearchArgs(args, undefined)).toBe(args);
    expect(translateVectorSearchArgs(args, { q: 'query', k: 'topK' })).toEqual({
      query: 'query',
      topK: 3
    });
  });
});
