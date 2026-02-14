import { jest, describe, test, expect } from '@jest/globals';
import { createAbortError } from '@/modules/shared/index.ts';
import {
  executeQueryPriorityCandidates,
  hasQueryPriority,
  resolveDefaultQueryPriorityCandidate,
  validateQueryPriorityCandidates
} from '@/modules/vector/internal/query-priority/index.ts';
import { executeQueryPriorityInternal } from '@/modules/vector/internal/query-priority/internal/execute.ts';

function createLogger() {
  return {
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  } as any;
}

describe('utils/vector/query-priority', () => {
  test('resolveDefaultQueryPriorityCandidate applies candidate/context/default precedence', () => {
    const resolved = resolveDefaultQueryPriorityCandidate(
      {
        collection: 'candidate-collection',
        embeddingPriority: [{ provider: 'emb-a' }]
      } as any,
      0,
      {
        stores: ['context-store'],
        mode: 'auto',
        topK: 7,
        scoreThreshold: 0.4,
        filter: { topic: 'context' }
      } as any
    );

    expect(resolved.stores).toEqual(['context-store']);
    expect(resolved.collection).toBe('candidate-collection');
    expect(resolved.embeddingPriority).toEqual([{ provider: 'emb-a' }]);
    expect(resolved.topK).toBe(7);
    expect(resolved.scoreThreshold).toBe(0.4);
    expect(resolved.filter).toEqual({ topic: 'context' });
  });

  test('resolveDefaultQueryPriorityCandidate prefers candidate stores and topK when provided', () => {
    const resolved = resolveDefaultQueryPriorityCandidate(
      {
        stores: ['candidate-store'],
        collection: 'candidate-collection',
        embeddingPriority: [{ provider: 'emb-a', model: 'emb-model' }],
        topK: 3
      } as any,
      0,
      {
        stores: ['context-store'],
        mode: 'auto',
        topK: 7
      } as any
    );

    expect(resolved.stores).toEqual(['candidate-store']);
    expect(resolved.topK).toBe(3);
  });

  test('resolveDefaultQueryPriorityCandidate falls back to adapter default topK', () => {
    const resolved = resolveDefaultQueryPriorityCandidate(
      {
        collection: 'candidate-collection',
        embeddingPriority: [{ provider: 'emb-a' }]
      } as any,
      0,
      {
        stores: ['context-store'],
        mode: 'auto'
      } as any
    );

    expect(resolved.topK).toBe(5);
  });

  test('hasQueryPriority reports availability correctly', () => {
    expect(hasQueryPriority({ mode: 'auto', queryPriority: [] } as any)).toBe(false);
    expect(hasQueryPriority({
      mode: 'auto',
      queryPriority: [{ collection: 'c', embeddingPriority: [{ provider: 'emb-a' }] }]
    } as any)).toBe(true);
  });

  test('validateQueryPriorityCandidates returns normalized candidates for valid config', () => {
    const validated = validateQueryPriorityCandidates({
      stores: ['context-store'],
      mode: 'auto',
      queryPriority: [
        {
          collection: '  candidate-collection  ',
          embeddingPriority: [{ provider: 'emb-a' }]
        }
      ]
    } as any);

    expect(validated).toHaveLength(1);
    expect(validated[0].collection).toBe('candidate-collection');
  });

  test('executeQueryPriorityCandidates returns empty result when queryPriority is missing', async () => {
    const result = await executeQueryPriorityCandidates({
      query: 'test query',
      contextConfig: {
        stores: ['context-store'],
        mode: 'auto'
      } as any,
      registry: {} as any,
      embeddingManager: {} as any,
      vectorManager: {} as any,
      logger: createLogger()
    } as any);

    expect(result).toEqual({ completed: false, results: [] });
  });

  test('executeQueryPriorityCandidates uses custom resolver when provided', async () => {
    const logger = createLogger();
    const resolveCandidate = jest.fn().mockImplementation(() => ({
      stores: ['context-store'],
      collection: 'resolved-collection',
      embeddingPriority: [{ provider: 'emb-a' }],
      topK: 1
    }));

    const queryCompat = {
      query: jest.fn().mockResolvedValue([{ id: 'r1', score: 0.9, text: 'match' }])
    };

    const result = await executeQueryPriorityCandidates({
      query: 'test query',
      contextConfig: {
        stores: ['context-store'],
        mode: 'auto',
        queryPriority: [
          {
            collection: 'candidate-collection',
            embeddingPriority: [{ provider: 'emb-a' }]
          }
        ]
      } as any,
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockResolvedValue({ vectors: [[0.1, 0.2]], model: 'm', dimensions: 2 })
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue(queryCompat)
      } as any,
      logger,
      resolveCandidate
    } as any);

    expect(resolveCandidate).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  test('executeQueryPriorityCandidates falls back to default resolver when custom resolver is absent', async () => {
    const result = await executeQueryPriorityCandidates({
      query: 'test query',
      contextConfig: {
        stores: ['context-store'],
        mode: 'auto',
        queryPriority: [
          {
            collection: 'candidate-collection',
            embeddingPriority: [{ provider: 'emb-a' }],
            topK: 1
          }
        ]
      } as any,
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockResolvedValue({ vectors: [[0.1, 0.2]], model: 'm', dimensions: 2 })
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue({
          query: jest.fn().mockResolvedValue([])
        })
      } as any,
      logger: createLogger()
    } as any);

    expect(result.completed).toBe(true);
    expect(result.results).toEqual([]);
  });

  test('executeQueryPriorityInternal skips candidates with no stores and returns exhausted empty result', async () => {
    const logger = createLogger();

    const result = await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: [],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn()
      } as any,
      vectorManager: {
        getCompat: jest.fn()
      } as any,
      logger,
      resolveCandidate: candidate => candidate as any
    });

    expect(result.completed).toBe(false);
    expect(result.results).toEqual([]);
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority candidate skipped because no stores are configured',
      expect.objectContaining({ 'vector.failureReason': 'no_stores' })
    );
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority exhausted without a completed candidate',
      expect.objectContaining({ 'vector.failureReason': 'all_candidates_failed' })
    );
  });

  test('executeQueryPriorityInternal rethrows when abortSignal is already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn()
      } as any,
      vectorManager: {
        getCompat: jest.fn()
      } as any,
      logger: createLogger(),
      resolveCandidate: candidate => candidate as any,
      abortSignal: abortController.signal
    })).rejects.toMatchObject({ code: 'aborted' });
  });

  test('executeQueryPriorityInternal rethrows abort-like embedding errors', async () => {
    await expect(executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockRejectedValue(createAbortError('embed aborted'))
      } as any,
      vectorManager: {
        getCompat: jest.fn()
      } as any,
      logger: createLogger(),
      resolveCandidate: candidate => candidate as any
    })).rejects.toMatchObject({ code: 'aborted' });
  });

  test('executeQueryPriorityInternal continues store loop when compat is unavailable and returns exhausted empty result', async () => {
    const logger = createLogger();
    const getCompat = jest.fn().mockResolvedValue(null);

    const result = await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'm',
          dimensions: 2
        })
      } as any,
      vectorManager: {
        getCompat
      } as any,
      logger,
      resolveCandidate: candidate => candidate as any
    });

    expect(result.completed).toBe(false);
    expect(result.results).toEqual([]);
    expect(getCompat).toHaveBeenCalledWith('context-store');
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority store query failed',
      expect.objectContaining({ 'vector.failureReason': 'query_error' })
    );
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority candidate failed because no store call completed',
      expect.objectContaining({ 'vector.failureReason': 'candidate_failed' })
    );
  });

  test('executeQueryPriorityInternal logs unknown embedding fields for empty embedding priority', async () => {
    const logger = createLogger();

    await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: [],
          collection: 'candidate-collection',
          embeddingPriority: [],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn()
      } as any,
      vectorManager: {
        getCompat: jest.fn()
      } as any,
      logger,
      resolveCandidate: candidate => candidate as any
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority candidate skipped because no stores are configured',
      expect.objectContaining({
        'vector.embedding.provider': 'unknown',
        'vector.embedding.model': ''
      })
    );
  });

  test('executeQueryPriorityInternal forwards abort signal into embed call when active', async () => {
    const abortController = new AbortController();
    const embed = jest.fn().mockResolvedValue({
      vectors: [[0.1, 0.2]],
      model: 'm',
      dimensions: 2
    });

    await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue({
          query: jest.fn().mockResolvedValue([])
        })
      } as any,
      logger: createLogger(),
      resolveCandidate: candidate => candidate as any,
      abortSignal: abortController.signal
    });

    expect(embed).toHaveBeenCalledWith(
      'test query',
      [{ provider: 'emb-a' }],
      { signal: abortController.signal }
    );
  });

  test('executeQueryPriorityInternal logs non-Error embedding failures and falls back to next candidate', async () => {
    const logger = createLogger();
    const embed = jest
      .fn()
      .mockRejectedValueOnce('embed failed')
      .mockResolvedValueOnce({
        vectors: [[0.1, 0.2]],
        model: 'm',
        dimensions: 2
      });

    const result = await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection-a',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any,
        {
          stores: ['context-store'],
          collection: 'candidate-collection-b',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue({
          query: jest.fn().mockResolvedValue([])
        })
      } as any,
      logger,
      resolveCandidate: candidate => candidate as any
    });

    expect(result.completed).toBe(true);
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority candidate embedding failed',
      expect.objectContaining({
        'vector.failureReason': 'embed_error',
        error: 'embed failed'
      })
    );
  });

  test('executeQueryPriorityInternal treats non-array store results as successful empty completion', async () => {
    const result = await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'm',
          dimensions: 2
        })
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue({
          query: jest.fn().mockResolvedValue(null)
        })
      } as any,
      logger: createLogger(),
      resolveCandidate: candidate => candidate as any
    });

    expect(result.completed).toBe(true);
    expect(result.results).toEqual([]);
  });

  test('executeQueryPriorityInternal logs non-Error store query failures', async () => {
    const logger = createLogger();

    const result = await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'm',
          dimensions: 2
        })
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue({
          query: jest.fn().mockRejectedValue('query failed')
        })
      } as any,
      logger,
      resolveCandidate: candidate => candidate as any
    });

    expect(result.completed).toBe(false);
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority store query failed',
      expect.objectContaining({
        'vector.failureReason': 'query_error',
        error: 'query failed'
      })
    );
  });

  test('executeQueryPriorityInternal logs configured embedding model when provided', async () => {
    const logger = createLogger();

    await executeQueryPriorityInternal({
      query: 'test query',
      contextConfig: { stores: ['context-store'], mode: 'auto' } as any,
      candidates: [
        {
          stores: ['context-store'],
          collection: 'candidate-collection',
          embeddingPriority: [{ provider: 'emb-a', model: 'emb-model' }],
          topK: 1
        } as any
      ],
      registry: {} as any,
      embeddingManager: {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'm',
          dimensions: 2
        })
      } as any,
      vectorManager: {
        getCompat: jest.fn().mockResolvedValue({
          query: jest.fn().mockRejectedValue(new Error('query failed'))
        })
      } as any,
      logger,
      resolveCandidate: candidate => candidate as any
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'Vector queryPriority store query failed',
      expect.objectContaining({
        'vector.embedding.model': 'emb-model'
      })
    );
  });
});
