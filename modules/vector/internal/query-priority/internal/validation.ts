import type { VectorContextConfig, VectorQueryCandidate } from '../../../../../kernel/index.js';
import { createConfigError } from './errors.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateQueryPriorityConfig(config: VectorContextConfig): VectorQueryCandidate[] {
  const rawCandidates = Array.isArray(config.queryPriority) ? config.queryPriority.filter(Boolean) : [];
  if (rawCandidates.length < 1) {
    return [];
  }

  if (config.locks?.collection !== undefined) {
    throw createConfigError('Invalid vector configuration: queryPriority cannot be used with locks.collection.');
  }

  const candidates: VectorQueryCandidate[] = [];
  for (let i = 0; i < rawCandidates.length; i += 1) {
    const candidate = rawCandidates[i] as VectorQueryCandidate;

    if (!isNonEmptyString(candidate.collection)) {
      throw createConfigError(
        `Invalid vector configuration: queryPriority[${i}] must include a non-empty collection.`
      );
    }

    if (!Array.isArray(candidate.embeddingPriority) || candidate.embeddingPriority.length < 1) {
      throw createConfigError(
        `Invalid vector configuration: queryPriority[${i}] must include embeddingPriority.`
      );
    }

    candidates.push({
      ...candidate,
      collection: candidate.collection.trim()
    });
  }

  return candidates;
}
