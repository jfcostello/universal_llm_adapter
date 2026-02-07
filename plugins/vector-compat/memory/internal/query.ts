import type { VectorPoint, VectorQueryOptions, VectorQueryResult } from '../../../../kernel/index.js';
import { cosineSimilarity, matchesFlatFilter } from '../../../../modules/vector/index.js';

export function queryCollection(
  coll: Map<string, VectorPoint>,
  vector: number[],
  topK: number,
  options?: VectorQueryOptions
): VectorQueryResult[] {
  if (options?.signal?.aborted) {
    return [];
  }

  const scored: Array<{ id: string; score: number; point: VectorPoint }> = [];

  for (const [id, point] of coll.entries()) {
    if (options?.signal?.aborted) {
      return [];
    }
    if (options?.filter && !matchesFlatFilter(point.payload, options.filter)) {
      continue;
    }

    const score = cosineSimilarity(vector, point.vector);
    scored.push({ id, score, point });
  }

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, topK);

  return topResults.map(item => ({
    id: item.id,
    score: item.score,
    payload: options?.includePayload !== false ? item.point.payload : undefined,
    vector: options?.includeVector ? item.point.vector : undefined
  }));
}
