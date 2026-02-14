import type { EmbeddingPriorityItem, VectorQueryResult } from '../../../../../kernel/index.js';
import { isAbortLikeError } from '../../../../shared/index.js';
import { buildEmbeddingCacheKey } from './cache-key.js';
import type {
  ExecuteQueryPriorityInternalOptions,
  QueryPriorityExecutionResult,
  QueryPriorityResolvedCandidate
} from './types.js';

function getEmbeddingLogFields(priority: EmbeddingPriorityItem[]): { provider: string; model: string } {
  const first = priority[0];
  return {
    provider: String(first?.provider ?? 'unknown'),
    model: first?.model ? String(first.model) : ''
  };
}

function buildLogFields(
  contextIndex: number,
  candidateIndex: number,
  candidate: QueryPriorityResolvedCandidate,
  resultsCount: number,
  failureReason: string
): Record<string, unknown> {
  const embedding = getEmbeddingLogFields(candidate.embeddingPriority);
  return {
    'vector.contextIndex': contextIndex,
    'vector.candidateIndex': candidateIndex,
    'vector.collection': candidate.collection,
    'vector.embedding.provider': embedding.provider,
    'vector.embedding.model': embedding.model,
    'vector.resultsCount': resultsCount,
    'vector.failureReason': failureReason
  };
}

function applyResultGuards(
  results: VectorQueryResult[],
  candidate: QueryPriorityResolvedCandidate
): VectorQueryResult[] {
  let guarded = results;
  if (candidate.scoreThreshold !== undefined) {
    guarded = guarded.filter(result => result.score >= candidate.scoreThreshold!);
  }
  return guarded.slice(0, candidate.topK);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Vector query execution aborted');
    (error as any).name = 'AbortError';
    (error as any).code = 'aborted';
    throw error;
  }
}

function rethrowAbortIfNeeded(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || isAbortLikeError(error, { includeMessage: true })) {
    throw error;
  }
}

export async function executeQueryPriorityInternal(
  options: ExecuteQueryPriorityInternalOptions
): Promise<QueryPriorityExecutionResult> {
  const contextIndex = Number.isFinite(options.contextIndex) ? Number(options.contextIndex) : -1;

  for (let candidateIndex = 0; candidateIndex < options.candidates.length; candidateIndex += 1) {
    throwIfAborted(options.abortSignal);

    const candidateSpec = options.candidates[candidateIndex];
    const candidate = options.resolveCandidate(candidateSpec, candidateIndex, options.contextConfig);

    if (!Array.isArray(candidate.stores) || candidate.stores.length < 1) {
      options.logger.warning(
        'Vector queryPriority candidate skipped because no stores are configured',
        buildLogFields(contextIndex, candidateIndex, candidate, 0, 'no_stores')
      );
      continue;
    }

    let queryVector: number[];
    try {
      const cacheKey = buildEmbeddingCacheKey(options.query, candidate.embeddingPriority);
      queryVector = options.embeddingCache?.get(cacheKey) ?? [];

      if (queryVector.length < 1) {
        const embeddingResult = await options.embeddingManager.embed(
          options.query,
          candidate.embeddingPriority,
          options.abortSignal ? { signal: options.abortSignal } : undefined
        );
        queryVector = embeddingResult.vectors[0];
        options.embeddingCache?.set(cacheKey, queryVector);
      }
    } catch (error) {
      rethrowAbortIfNeeded(error, options.abortSignal);
      options.logger.warning('Vector queryPriority candidate embedding failed', {
        ...buildLogFields(contextIndex, candidateIndex, candidate, 0, 'embed_error'),
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    let rawResults: VectorQueryResult[] = [];
    let completedStoreId: string | undefined;

    for (const storeId of candidate.stores) {
      throwIfAborted(options.abortSignal);
      try {
        const compat = await options.vectorManager.getCompat(storeId);
        if (!compat) {
          throw new Error(`Vector store not available: ${storeId}`);
        }

        const storeResults = await compat.query(
          candidate.collection,
          queryVector,
          candidate.topK,
          {
            filter: candidate.filter,
            includePayload: true,
            signal: options.abortSignal,
            timeoutMs: options.queryTimeoutMs
          }
        );

        completedStoreId = storeId;
        rawResults = Array.isArray(storeResults) ? storeResults : [];
        break;
      } catch (error) {
        rethrowAbortIfNeeded(error, options.abortSignal);
        options.logger.warning('Vector queryPriority store query failed', {
          ...buildLogFields(contextIndex, candidateIndex, candidate, 0, 'query_error'),
          storeId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (!completedStoreId) {
      options.logger.warning(
        'Vector queryPriority candidate failed because no store call completed',
        buildLogFields(contextIndex, candidateIndex, candidate, 0, 'candidate_failed')
      );
      continue;
    }

    const results = applyResultGuards(rawResults, candidate);

    options.logger.info('Vector queryPriority candidate completed', {
      ...buildLogFields(contextIndex, candidateIndex, candidate, results.length, 'none'),
      storeId: completedStoreId
    });

    return {
      completed: true,
      results,
      storeId: completedStoreId,
      candidateIndex,
      effectiveCandidate: candidate
    };
  }

  options.logger.warning('Vector queryPriority exhausted without a completed candidate', {
    'vector.contextIndex': contextIndex,
    'vector.candidateIndex': -1,
    'vector.collection': '',
    'vector.embedding.provider': '',
    'vector.embedding.model': '',
    'vector.resultsCount': 0,
    'vector.failureReason': 'all_candidates_failed'
  });

  return {
    completed: false,
    results: []
  };
}
