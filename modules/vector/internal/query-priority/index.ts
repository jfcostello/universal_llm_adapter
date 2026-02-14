import { getDefaults } from '../../../../kernel/index.js';
import type { VectorContextConfig, VectorQueryCandidate } from '../../../../kernel/index.js';
import { executeQueryPriorityInternal } from './internal/execute.js';
import type {
  ExecuteQueryPriorityOptions,
  QueryPriorityResolvedCandidate,
  ResolveQueryPriorityCandidate
} from './internal/types.js';
import { validateQueryPriorityConfig } from './internal/validation.js';

export type {
  ExecuteQueryPriorityOptions,
  QueryPriorityExecutionResult,
  QueryPriorityResolvedCandidate,
  ResolveQueryPriorityCandidate
} from './internal/types.js';

export function hasQueryPriority(config: VectorContextConfig): boolean {
  return Array.isArray(config.queryPriority) && config.queryPriority.length > 0;
}

export function resolveDefaultQueryPriorityCandidate(
  candidate: VectorQueryCandidate,
  _candidateIndex: number,
  contextConfig: VectorContextConfig
): QueryPriorityResolvedCandidate {
  const topK = candidate.topK ?? contextConfig.topK ?? getDefaults().vector.topK;
  return {
    stores: Array.isArray(candidate.stores) && candidate.stores.length > 0
      ? candidate.stores
      : contextConfig.stores,
    collection: candidate.collection,
    embeddingPriority: candidate.embeddingPriority,
    topK,
    scoreThreshold: candidate.scoreThreshold ?? contextConfig.scoreThreshold,
    filter: candidate.filter ?? contextConfig.filter
  };
}

export function validateQueryPriorityCandidates(config: VectorContextConfig): VectorQueryCandidate[] {
  return validateQueryPriorityConfig(config);
}

export async function executeQueryPriorityCandidates(
  options: ExecuteQueryPriorityOptions
) {
  const candidates = validateQueryPriorityConfig(options.contextConfig);
  if (candidates.length < 1) {
    return { completed: false, results: [] };
  }

  const resolveCandidate: ResolveQueryPriorityCandidate =
    options.resolveCandidate ?? resolveDefaultQueryPriorityCandidate;

  return executeQueryPriorityInternal({
    ...options,
    candidates,
    resolveCandidate
  });
}
