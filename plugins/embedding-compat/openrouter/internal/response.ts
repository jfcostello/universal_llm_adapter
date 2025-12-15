import type { EmbeddingProviderConfig, EmbeddingResult } from '../../../../modules/kernel/index.js';
import { EmbeddingProviderError } from '../../../../modules/kernel/index.js';
import { extractEmbeddingVectorsByIndex } from '../../../../modules/embeddings/index.js';
import type { OpenRouterEmbeddingResponse } from './mappings.js';

export function isRateLimitResponse(status: number, body: any): boolean {
  if (status === 429) return true;

  if (typeof body === 'string') {
    return body.toLowerCase().includes('rate');
  }

  const message = body?.error?.message;
  if (typeof message === 'string') {
    return message.toLowerCase().includes('rate');
  }

  return false;
}

export function parseEmbeddingResponse(
  raw: any,
  status: number,
  config: EmbeddingProviderConfig,
  effectiveModel: string
): EmbeddingResult {
  const data = raw as OpenRouterEmbeddingResponse;

  if (!data.data || !Array.isArray(data.data)) {
    const errorMsg = (data as any)?.error?.message || (typeof data === 'string' ? data : JSON.stringify(data));
    throw new EmbeddingProviderError('openrouter', `Invalid response structure: ${errorMsg}`, status);
  }

  const vectors = extractEmbeddingVectorsByIndex(data.data);
  const dimensions = vectors[0]?.length || config.dimensions || 0;

  return {
    vectors,
    model: data.model || effectiveModel,
    dimensions,
    tokenCount: data.usage?.total_tokens
  };
}

