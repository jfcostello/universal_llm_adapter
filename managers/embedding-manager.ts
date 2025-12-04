import {
  EmbeddingProviderConfig,
  EmbeddingPriorityItem,
  EmbeddingResult,
  IEmbeddingCompat,
  IOperationLogger
} from '../core/types.js';
import { EmbeddingError, EmbeddingProviderError } from '../core/errors.js';
import { EmbedderFn } from './vector-store-manager.js';

/**
 * EmbeddingManager - Agnostic embedding orchestration with priority-based fallback
 *
 * This manager handles embedding text into vectors using configured providers.
 * It supports priority-based provider selection with automatic fallback.
 *
 * All provider-specific logic is delegated to compat modules in plugins/embedding-compat/
 */
export class EmbeddingManager {
  private logger?: IOperationLogger;

  constructor(private registry: any, logger?: IOperationLogger) {
    this.logger = logger;
  }

  /**
   * Embed text using priority-based providers with fallback
   *
   * @param input - Single text or array of texts to embed
   * @param priority - Ordered list of providers to try
   * @returns EmbeddingResult with vectors
   * @throws EmbeddingError if all providers fail
   */
  async embed(
    input: string | string[],
    priority: EmbeddingPriorityItem[]
  ): Promise<EmbeddingResult> {
    if (!priority || priority.length === 0) {
      throw new EmbeddingError('No embedding providers specified in priority list');
    }

    const errors: Error[] = [];

    for (const item of priority) {
      try {
        const config = await this.registry.getEmbeddingProvider(item.provider);
        const compat = await this.registry.getEmbeddingCompat(config.kind);

        // Pass logger to compat for HTTP logging
        const result = await compat.embed(input, config, item.model, this.logger);
        return result;
      } catch (error: any) {
        errors.push(error);

        // If it's a rate limit error, continue to next provider
        if (error instanceof EmbeddingProviderError && error.isRateLimit) {
          continue;
        }

        // For other provider errors, also try next provider
        if (error instanceof EmbeddingProviderError) {
          continue;
        }

        // For config/compat loading errors, try next provider
        continue;
      }
    }

    // All providers failed
    const lastError = errors[errors.length - 1];
    throw new EmbeddingError(
      `All embedding providers failed. Last error: ${lastError?.message || 'Unknown error'}`,
      priority[priority.length - 1]?.provider
    );
  }

  /**
   * Get the expected dimensions for an embedding provider/model
   *
   * @param providerId - The embedding provider ID
   * @param model - Optional model override
   * @returns Number of dimensions
   */
  async getDimensions(providerId: string, model?: string): Promise<number> {
    const config = await this.registry.getEmbeddingProvider(providerId);
    const compat = await this.registry.getEmbeddingCompat(config.kind);
    return compat.getDimensions(config, model);
  }

  /**
   * Create an EmbedderFn compatible with VectorStoreManager
   *
   * This allows the VectorStoreManager to use embedding without
   * knowing about the EmbeddingManager directly.
   *
   * @param priority - Ordered list of providers to try
   * @returns EmbedderFn function
   */
  createEmbedderFn(priority: EmbeddingPriorityItem[]): EmbedderFn {
    return async (text: string | string[]): Promise<number[] | number[][]> => {
      const result = await this.embed(text, priority);

      // If single text was provided, return single vector
      if (typeof text === 'string') {
        return result.vectors[0];
      }

      // Otherwise return all vectors
      return result.vectors;
    };
  }

  /**
   * Validate that an embedding provider is accessible
   *
   * @param providerId - The embedding provider ID
   * @returns true if provider is accessible
   */
  async validate(providerId: string): Promise<boolean> {
    try {
      const config = await this.registry.getEmbeddingProvider(providerId);
      const compat = await this.registry.getEmbeddingCompat(config.kind);

      if (typeof compat.validate === 'function') {
        return await compat.validate(config);
      }

      // If no validate method, try a minimal embed
      await compat.embed('test', config, undefined, this.logger);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set the logger for this manager
   */
  setLogger(logger: IOperationLogger): void {
    this.logger = logger;
  }
}
