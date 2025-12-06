import axios, { AxiosInstance } from 'axios';
import {
  IEmbeddingCompat,
  EmbeddingProviderConfig,
  EmbeddingResult,
  IEmbeddingOperationLogger
} from '../../core/types.js';
import { EmbeddingProviderError } from '../../core/errors.js';
import { getDefaults } from '../../core/defaults.js';

/**
 * OpenRouter Embeddings API Response format
 */
interface OpenRouterEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * OpenRouter Embedding Compat Module
 *
 * Handles communication with OpenRouter's embeddings API.
 * API Reference: https://openrouter.ai/docs/api/reference/embeddings
 *
 * This compat is 100% generic - it knows how to talk to OpenRouter's API
 * but has NO knowledge of specific models. Model info comes from JSON config.
 */
export default class OpenRouterEmbeddingCompat implements IEmbeddingCompat {
  private httpClient: AxiosInstance;

  constructor(httpClient?: AxiosInstance) {
    this.httpClient = httpClient || axios.create({
      timeout: getDefaults().timeouts.embeddingHttp,
      validateStatus: () => true
    });
  }

  async embed(
    input: string | string[],
    config: EmbeddingProviderConfig,
    model?: string,
    logger?: IEmbeddingOperationLogger
  ): Promise<EmbeddingResult> {
    const effectiveModel = model || config.model;
    const url = config.endpoint.urlTemplate;
    const headers = config.endpoint.headers;

    const payload = {
      model: effectiveModel,
      input: input
    };

    try {
      // Log the request
      logger?.logEmbeddingRequest({
        url,
        method: 'POST',
        headers,
        body: payload,
        provider: 'openrouter',
        model: effectiveModel
      });

      const response = await this.httpClient.request({
        method: 'POST',
        url,
        headers,
        data: payload
      });

      if (response.status >= 400) {
        // Log error response
        logger?.logEmbeddingResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers || {},
          body: response.data
        });

        const isRateLimit = response.status === 429 ||
          (typeof response.data === 'string' && response.data.toLowerCase().includes('rate')) ||
          (response.data?.error?.message?.toLowerCase().includes('rate'));

        throw new EmbeddingProviderError(
          'openrouter',
          typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
          response.status,
          isRateLimit
        );
      }

      const data = response.data as OpenRouterEmbeddingResponse;

      // Sort by index to ensure correct order
      const sortedData = [...data.data].sort((a, b) => a.index - b.index);
      const vectors = sortedData.map(item => item.embedding);

      // Dimensions come from the actual response or config - never hardcoded
      const dimensions = vectors[0]?.length || config.dimensions || 0;

      // Log successful response
      logger?.logEmbeddingResponse({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers || {},
        body: data,
        dimensions,
        tokenCount: data.usage?.total_tokens
      });

      return {
        vectors,
        model: data.model || effectiveModel,
        dimensions,
        tokenCount: data.usage?.total_tokens
      };
    } catch (error: any) {
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }
      throw new EmbeddingProviderError('openrouter', error.message);
    }
  }

  getDimensions(config: EmbeddingProviderConfig, _model?: string): number {
    // Dimensions MUST come from config - this compat knows nothing about models
    return config.dimensions || 0;
  }

  async validate(config: EmbeddingProviderConfig): Promise<boolean> {
    try {
      await this.embed('test', config);
      return true;
    } catch {
      return false;
    }
  }
}
