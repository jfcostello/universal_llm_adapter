/**
 * VectorContextInjector - Handles RAG context injection for auto and both modes.
 * Retrieves relevant context from vector stores and injects into messages.
 */

import {
  Message,
  Role,
  VectorContextConfig,
  EmbeddingPriorityItem,
  TextContent,
  JsonObject
} from '../../core/types.js';
import { PluginRegistry } from '../../core/registry.js';
import { EmbeddingManager } from '../../managers/embedding-manager.js';
import { VectorStoreManager } from '../../managers/vector-store-manager.js';
import { getLogger, AdapterLogger } from '../../core/logging.js';

export interface VectorContextInjectorOptions {
  registry: PluginRegistry;
  embeddingManager?: EmbeddingManager;
  vectorManager?: VectorStoreManager;
}

export interface InjectionResult {
  messages: Message[];
  resultsInjected: number;
  query: string;
  retrievedResults: any[];
}

const DEFAULT_INJECT_TEMPLATE = 'Relevant context:\n{{results}}';
const DEFAULT_RESULT_FORMAT = '- {{payload.text}} (score: {{score}})';
const DEFAULT_TOP_K = 5;

export class VectorContextInjector {
  private registry: PluginRegistry;
  private embeddingManager?: EmbeddingManager;
  private vectorManager?: VectorStoreManager;
  private logger: AdapterLogger;
  private initializedStores: Set<string> = new Set();

  constructor(options: VectorContextInjectorOptions) {
    this.registry = options.registry;
    this.embeddingManager = options.embeddingManager;
    this.vectorManager = options.vectorManager;
    this.logger = getLogger();
  }

  /**
   * Inject vector context into messages based on configuration.
   * Returns modified messages with context pre-injected.
   */
  async injectContext(
    messages: Message[],
    config: VectorContextConfig,
    systemPrompt?: string
  ): Promise<InjectionResult> {
    // Only inject for 'auto' or 'both' modes
    if (config.mode === 'tool') {
      return {
        messages,
        resultsInjected: 0,
        query: '',
        retrievedResults: []
      };
    }

    // Extract query from last user message
    const query = this.extractQuery(messages);
    if (!query) {
      return {
        messages,
        resultsInjected: 0,
        query: '',
        retrievedResults: []
      };
    }

    try {
      // Ensure managers are initialized
      await this.ensureManagers(config.embeddingPriority);

      // Embed the query
      const embeddingPriority = config.embeddingPriority ?? this.getDefaultEmbeddingPriority();
      const embeddingResult = await this.embeddingManager!.embed(query, embeddingPriority);
      const queryVector = embeddingResult.vectors[0];

      // Query vector stores
      let results: any[] = [];
      for (const storeId of config.stores) {
        try {
          await this.ensureStoreInitialized(storeId);

          // getCompat will succeed since ensureStoreInitialized succeeded for this store
          // Both methods go through the same registry to load the compat
          // If it somehow returns null, compat.query() will throw and be caught below
          const compat = (await this.vectorManager!.getCompat(storeId))!;

          const storeConfig = await this.registry.getVectorStore(storeId);
          const collection = config.collection ?? storeConfig.defaultCollection ?? 'default';

          const storeResults = await compat.query(
            collection,
            queryVector,
            config.topK ?? DEFAULT_TOP_K,
            {
              filter: config.filter,
              includePayload: true
            }
          );

          results = [...results, ...storeResults];

          // If we got results, stop searching
          if (results.length > 0) break;
        } catch (error) {
          this.logger.warning('Vector store query failed', {
            storeId,
            error: error instanceof Error ? error.message : String(error)
          });
          // Continue to next store
        }
      }

      // Apply score threshold
      if (config.scoreThreshold !== undefined) {
        results = results.filter(r => r.score >= config.scoreThreshold!);
      }

      // Limit to topK
      results = results.slice(0, config.topK ?? DEFAULT_TOP_K);

      // If no results, return original messages
      if (results.length === 0) {
        return {
          messages,
          resultsInjected: 0,
          query,
          retrievedResults: []
        };
      }

      // Format results
      const formattedContext = this.formatResults(results, config);

      // Apply template
      const contextToInject = this.applyTemplate(formattedContext, config);

      // Inject into messages
      const modifiedMessages = this.injectIntoMessages(
        messages,
        contextToInject,
        config.injectAs ?? 'system',
        systemPrompt
      );

      return {
        messages: modifiedMessages,
        resultsInjected: results.length,
        query,
        retrievedResults: results
      };
    } catch (error) {
      // ensureManagers and embeddingManager.embed() throw proper Error instances
      this.logger.warning('Vector context injection failed', {
        error: (error as Error).message
      });
      // On error, return original messages
      return {
        messages,
        resultsInjected: 0,
        query,
        retrievedResults: []
      };
    }
  }

  /**
   * Extract the query from the last user message.
   */
  private extractQuery(messages: Message[]): string {
    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === Role.USER) {
        // Find text content
        for (const part of message.content) {
          if (part.type === 'text') {
            const text = (part as TextContent).text;
            if (text && text.trim()) {
              return text.trim();
            }
          }
        }
      }
    }
    return '';
  }

  /**
   * Format results using the configured template.
   */
  private formatResults(results: any[], config: VectorContextConfig): string {
    const format = config.resultFormat ?? DEFAULT_RESULT_FORMAT;

    const formattedLines = results.map(result => {
      return this.interpolate(format, {
        id: result.id,
        score: result.score,
        payload: result.payload ?? {}
      });
    });

    return formattedLines.join('\n');
  }

  /**
   * Apply the injection template.
   */
  private applyTemplate(content: string, config: VectorContextConfig): string {
    const template = config.injectTemplate ?? DEFAULT_INJECT_TEMPLATE;
    return template.replace('{{results}}', content);
  }

  /**
   * Inject context into messages.
   */
  private injectIntoMessages(
    messages: Message[],
    context: string,
    injectAs: 'system' | 'user_context',
    systemPrompt?: string
  ): Message[] {
    const result = [...messages];

    if (injectAs === 'system') {
      // Create or update system message at the start
      const systemContent = systemPrompt
        ? `${systemPrompt}\n\n${context}`
        : context;

      const systemMessage: Message = {
        role: Role.SYSTEM,
        content: [{ type: 'text', text: systemContent }]
      };

      // Check if there's already a system message
      if (result.length > 0 && result[0].role === Role.SYSTEM) {
        // Append to existing system message
        const existingText = (result[0].content[0] as TextContent)?.text ?? '';
        result[0] = {
          ...result[0],
          content: [{ type: 'text', text: `${existingText}\n\n${context}` }]
        };
      } else {
        // Insert at the beginning
        result.unshift(systemMessage);
      }
    } else {
      // Insert as user context before the last user message
      const contextMessage: Message = {
        role: Role.USER,
        content: [{ type: 'text', text: context }]
      };

      // Find the last user message and insert before it
      let lastUserIndex = -1;
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === Role.USER) {
          lastUserIndex = i;
          break;
        }
      }

      // Insert before the last user message
      // Note: lastUserIndex is always >= 0 here because extractQuery() requires a user message
      result.splice(lastUserIndex, 0, contextMessage);
    }

    return result;
  }

  /**
   * Simple template interpolation.
   * Supports {{key}} and {{nested.key}} patterns.
   */
  private interpolate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const keys = key.trim().split('.');
      let value: any = data;

      for (const k of keys) {
        if (value === undefined || value === null) return '';
        value = value[k];
      }

      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  /**
   * Get default embedding priority.
   */
  private getDefaultEmbeddingPriority(): EmbeddingPriorityItem[] {
    return [{ provider: 'openrouter-embeddings' }];
  }

  /**
   * Ensure managers are initialized.
   */
  private async ensureManagers(embeddingPriority?: EmbeddingPriorityItem[]): Promise<void> {
    if (!this.embeddingManager) {
      // Pass logger to embedding manager for HTTP request logging
      this.embeddingManager = new EmbeddingManager(this.registry, this.logger);
    }
    if (!this.vectorManager) {
      // Pass logger to vector manager for operation logging
      this.vectorManager = new VectorStoreManager(
        new Map(),  // configs - will be loaded from registry
        new Map(),  // adapters - will be created via compat
        undefined,  // embedder - not needed, we use EmbeddingManager directly
        this.registry,
        this.logger  // logger for vector operations
      );
    }
  }

  /**
   * Ensure a vector store is initialized.
   */
  private async ensureStoreInitialized(storeId: string): Promise<void> {
    if (this.initializedStores.has(storeId)) {
      return;
    }

    const storeConfig = await this.registry.getVectorStore(storeId);
    const compat = await this.registry.getVectorStoreCompat(storeConfig.kind);

    // Inject logger for operation logging
    if (typeof compat.setLogger === 'function') {
      compat.setLogger(this.logger);
    }

    await compat.connect(storeConfig);
    this.initializedStores.add(storeId);
  }
}
