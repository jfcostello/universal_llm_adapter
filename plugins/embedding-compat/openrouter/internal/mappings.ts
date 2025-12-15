/**
 * OpenRouter Embeddings API response shape (subset).
 */
export interface OpenRouterEmbeddingResponse {
  object: string;
  data: Array<{
    object?: string;
    index: number;
    embedding: number[];
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

