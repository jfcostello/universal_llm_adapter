import type { EmbeddingPriorityItem } from '../../../../../kernel/index.js';

export function buildEmbeddingCacheKey(query: string, priority: EmbeddingPriorityItem[]): string {
  const normalizedPriority = priority
    .map(item => `${String(item.provider)}:${item.model ? String(item.model) : ''}`)
    .join('|');
  return `${query}::${normalizedPriority}`;
}
