import type { AxiosInstance } from 'axios';
import {
  IEmbeddingCompat,
  EmbeddingProviderConfig,
  EmbeddingResult,
  EmbeddingError,
  IEmbeddingOperationLogger,
  EmbeddingProviderError
} from '../../../../kernel/index.js';
import { isAbortLikeError } from '../../../../modules/shared/index.js';
import { createOpenRouterEmbeddingHttpClient } from './http.js';
import { isRateLimitResponse, parseEmbeddingResponse } from './response.js';

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
    this.httpClient = httpClient || createOpenRouterEmbeddingHttpClient();
  }

  async embed(
    input: string | string[],
    config: EmbeddingProviderConfig,
    model?: string,
    logger?: IEmbeddingOperationLogger,
    options: { signal?: AbortSignal } = {}
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
        data: payload,
        ...(options.signal ? { signal: options.signal } : {})
      });

      if (response.status >= 400) {
        // Log error response
        logger?.logEmbeddingResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers || {},
          body: response.data
        });

        const isRateLimit = isRateLimitResponse(response.status, response.data);

        throw new EmbeddingProviderError(
          'openrouter',
          typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
          response.status,
          isRateLimit
        );
      }

      const result = parseEmbeddingResponse(response.data, response.status, config, effectiveModel);

      // Log successful response
      logger?.logEmbeddingResponse({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers || {},
        body: response.data,
        dimensions: result.dimensions,
        tokenCount: result.tokenCount
      });

      return result;
    } catch (error: any) {
      if (options.signal?.aborted || isAbortLikeError(error)) {
        throw new EmbeddingError('Embedding request aborted');
      }
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingProviderError('openrouter', message);
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
