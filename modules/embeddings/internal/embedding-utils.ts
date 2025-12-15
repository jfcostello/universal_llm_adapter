export interface IndexedEmbeddingVector {
  index: number;
  embedding: number[];
}

export function extractEmbeddingVectorsByIndex(items: IndexedEmbeddingVector[]): number[][] {
  return [...items].sort((a, b) => a.index - b.index).map(item => item.embedding);
}

