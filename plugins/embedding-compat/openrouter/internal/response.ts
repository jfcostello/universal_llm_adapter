import type { EmbeddingProviderConfig, EmbeddingResult } from '../../../../kernel/index.js';
import { EmbeddingProviderError } from '../../../../kernel/index.js';
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

function extractMessage(body: any): string {
  if (typeof body === 'string') return body;
  const message = body?.error?.message;
  if (typeof message === 'string') return message;
  return '';
}

export function isTransientOpenRouterEmbeddingPayloadFailure(body: any): boolean {
  const message = extractMessage(body).toLowerCase();
  if (message.includes('no successful provider responses')) return true;

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
    const transientFailure = isTransientOpenRouterEmbeddingPayloadFailure(data);
    const effectiveStatus = transientFailure && status < 400 ? 503 : status;
    throw new EmbeddingProviderError('openrouter', `Invalid response structure: ${errorMsg}`, effectiveStatus);
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
