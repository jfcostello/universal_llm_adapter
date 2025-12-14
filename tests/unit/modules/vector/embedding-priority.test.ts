import { describe, expect, jest, test } from '@jest/globals';
import { resolveEmbeddingPriority } from '@/modules/vector/internal/embedding-priority.ts';

describe('modules/vector/internal/embedding-priority', () => {
  test('returns explicit priority without consulting registry', async () => {
    const registry = {
      getVectorStore: jest.fn()
    } as any;

    const explicit = [{ provider: 'explicit-provider' }];

    const result = await resolveEmbeddingPriority(
      { explicit, storeIds: ['store-a'] },
      registry
    );

    expect(result).toEqual(explicit);
    expect(registry.getVectorStore).not.toHaveBeenCalled();
  });

  test('throws when no explicit priority and no store defaults exist', async () => {
    const registry = {
      getVectorStore: jest.fn().mockResolvedValue({ id: 'store-a', kind: 'memory' })
    } as any;

    await expect(resolveEmbeddingPriority({ storeIds: ['store-a'] }, registry)).rejects.toThrow(
      'No embedding priority configured'
    );
  });

  test('returns store default embedding priority when present', async () => {
    const storeDefault = [{ provider: 'store-default-provider' }];

    const registry = {
      getVectorStore: jest.fn().mockResolvedValue({
        id: 'store-a',
        kind: 'memory',
        defaultEmbeddingPriority: storeDefault
      })
    } as any;

    const result = await resolveEmbeddingPriority(
      { storeIds: ['store-a'] },
      registry
    );

    expect(result).toEqual(storeDefault);
  });

  test('throws when stores specify different default embedding priorities', async () => {
    const registry = {
      getVectorStore: jest.fn().mockImplementation(async (storeId: string) => {
        if (storeId === 'store-a') {
          return {
            id: 'store-a',
            kind: 'memory',
            defaultEmbeddingPriority: [{ provider: 'a' }]
          };
        }
        return {
          id: 'store-b',
          kind: 'memory',
          defaultEmbeddingPriority: [{ provider: 'b' }]
        };
      })
    } as any;

    await expect(
      resolveEmbeddingPriority({ storeIds: ['store-b', 'store-a'] }, registry)
    ).rejects.toThrow('Multiple vector stores specify different default embedding priorities');
  });
});

