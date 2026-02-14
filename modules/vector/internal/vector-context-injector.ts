import { getDefaults, Message, QueryConstructionSettings, resolveLoggingDeps, Role, TextContent, VectorContextConfig } from '../../../kernel/index.js';
import type {
  AdapterLogger,
  IEmbeddingOperationLogger,
  IVectorOperationLogger,
  LoggingDeps,
  PluginRegistry
} from '../../../kernel/index.js';
import { interpolate } from '../../string/index.js';
import { createAbortError, truncateUtf8Bytes } from '../../shared/index.js';
import type { EmbeddingManager } from '../../embeddings/index.js';
import { VectorStoreManager } from './vector-store-manager.js';
import { resolveEmbeddingPriority } from './embedding-priority.js';
import { isCompleteVectorQueryResponse, resolveStorePriorityChain } from './store-priority/index.js';

export interface VectorContextInjectorOptions {
  registry: PluginRegistry;
  embeddingManager?: EmbeddingManager;
  vectorManager?: VectorStoreManager;
  logging?: Partial<LoggingDeps>;
}

export interface InjectionResult {
  messages: Message[];
  resultsInjected: number;
  query: string;
  retrievedResults: any[];
}

export interface InjectionOptions {
  maxInjectedPayloadBytes?: number;
  embeddingCache?: Map<string, number[]>;
  abortSignal?: AbortSignal;
  queryTimeoutMs?: number;
}

const getVectorDefaults = () => getDefaults().vector;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError('Vector context injection aborted');
  }
}

export class VectorContextInjector {
  private registry: PluginRegistry;
  private embeddingManager?: EmbeddingManager;
  private vectorManager?: VectorStoreManager;
  private logger: AdapterLogger;
  private logging: LoggingDeps;
  private embeddingLogger: IEmbeddingOperationLogger;
  private vectorLogger: IVectorOperationLogger;

  constructor(options: VectorContextInjectorOptions) {
    this.registry = options.registry;
    this.embeddingManager = options.embeddingManager;
    this.vectorManager = options.vectorManager;
    this.logging = resolveLoggingDeps(options.logging);
    this.logger = this.logging.getLogger();
    this.embeddingLogger = this.logging.getEmbeddingLogger();
    this.vectorLogger = this.logging.getVectorLogger();
  }

  async injectContext(
    messages: Message[],
    config: VectorContextConfig,
    systemPrompt?: string,
    options: InjectionOptions = {}
  ): Promise<InjectionResult> {
    if (config.mode === 'tool') {
      return {
        messages,
        resultsInjected: 0,
        query: '',
        retrievedResults: []
      };
    }

    const query = this.extractQuery(messages, config);
    if (!query) {
      return {
        messages,
        resultsInjected: 0,
        query: '',
        retrievedResults: []
      };
    }
    try {
      throwIfAborted(options.abortSignal);
      await this.ensureManagers();
      throwIfAborted(options.abortSignal);
      let results: any[] = [];
      storeLoop:
      for (const logicalStoreId of config.stores) {
        const storeChain = resolveStorePriorityChain(config, logicalStoreId);
        for (const attempt of storeChain.attempts) {
          const attemptStoreId = attempt.store;
          try {
            throwIfAborted(options.abortSignal);
            const embeddingPriority = await resolveEmbeddingPriority(
              {
                explicit: attempt.embeddingPriority ?? config.embeddingPriority,
                storeIds: [attemptStoreId]
              },
              this.registry
            );
            throwIfAborted(options.abortSignal);

            const embeddingCacheKey = this.buildEmbeddingCacheKey(query, embeddingPriority);
            let queryVector = options.embeddingCache?.get(embeddingCacheKey);
            if (!queryVector) {
              const embeddingResult = await this.embeddingManager!.embed(query, embeddingPriority, {
                signal: options.abortSignal
              });
              queryVector = embeddingResult.vectors[0];
              options.embeddingCache?.set(embeddingCacheKey, queryVector);
            }
            await this.ensureStoreInitialized(attemptStoreId);
            throwIfAborted(options.abortSignal);
            const compat = (await this.vectorManager!.getCompat(attemptStoreId))!;
            const storeConfig = await this.registry.getVectorStore(attemptStoreId);
            const collection = attempt.collection ?? config.collection ?? storeConfig.defaultCollection ?? 'default';
            const rawStoreResults = await compat.query(
              collection,
              queryVector,
              config.topK ?? getVectorDefaults().topK,
              {
                filter: config.filter,
                includePayload: true,
                signal: options.abortSignal,
                timeoutMs: options.queryTimeoutMs
              }
            );
            throwIfAborted(options.abortSignal);
            if (!isCompleteVectorQueryResponse(rawStoreResults)) {
              this.logger.warning('Vector store query returned incomplete response', {
                storeId: attemptStoreId
              });
              continue;
            }

            const storeResults = rawStoreResults as any[];
            results = storeResults;
            if (storeResults.length > 0 || !storeChain.fallbackOnEmpty) {
              break storeLoop;
            }
          } catch (error: any) {
            if (String(error?.code ?? '') === 'config_error') {
              throw error;
            }
            this.logger.warning('Vector store query failed', {
              storeId: attemptStoreId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      if (config.scoreThreshold !== undefined) {
        results = results.filter(r => r.score >= config.scoreThreshold!);
      }
      results = results.slice(0, config.topK ?? getVectorDefaults().topK);
      if (results.length === 0) {
        return {
          messages,
          resultsInjected: 0,
          query,
          retrievedResults: []
        };
      }
      const formattedContext = this.formatResults(results, config);
      const contextToInject = this.applyTemplate(formattedContext, config, options.maxInjectedPayloadBytes);
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
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warning('Vector context injection failed', { error: message });
      if (String(error?.code ?? '') === 'config_error') {
        throw error;
      }
      return {
        messages,
        resultsInjected: 0,
        query,
        retrievedResults: []
      };
    }
  }

  private extractQuery(messages: Message[], config: VectorContextConfig): string {
    if (config.overrideEmbeddingQuery && config.overrideEmbeddingQuery.trim()) {
      return config.overrideEmbeddingQuery.trim();
    }

    const defaults = getVectorDefaults().queryConstruction;
    const settings: QueryConstructionSettings = {
      includeSystemPrompt: config.queryConstruction?.includeSystemPrompt ?? defaults.includeSystemPrompt,
      includeAssistantMessages: config.queryConstruction?.includeAssistantMessages ?? defaults.includeAssistantMessages,
      messagesToInclude: config.queryConstruction?.messagesToInclude ?? defaults.messagesToInclude
    };

    let systemMessage: Message | null = null;
    let nonSystemMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === Role.SYSTEM) {
        systemMessage = msg;
      } else {
        nonSystemMessages.push(msg);
      }
    }

    let messagesToProcess: Message[] = [];

    if (settings.messagesToInclude === 0) {
      messagesToProcess = nonSystemMessages;
    } else {
      messagesToProcess = nonSystemMessages.slice(-settings.messagesToInclude);
    }

    messagesToProcess = messagesToProcess.filter(msg => {
      if (msg.role === Role.USER) return true;
      if (msg.role === Role.ASSISTANT && settings.includeAssistantMessages) return true;
      return false;
    });

    let includeSystem = false;
    if (systemMessage) {
      if (settings.includeSystemPrompt === 'always') {
        includeSystem = true;
      } else if (settings.includeSystemPrompt === 'if-in-range') {
        const totalMessages = messages.length;
        includeSystem = settings.messagesToInclude === 0 || totalMessages <= settings.messagesToInclude;
      }
    }

    const queryParts: string[] = [];

    if (includeSystem && systemMessage) {
      const systemText = this.extractTextFromMessage(systemMessage);
      if (systemText) {
        queryParts.push(systemText);
      }
    }

    for (const msg of messagesToProcess) {
      const text = this.extractTextFromMessage(msg);
      if (text) {
        queryParts.push(text);
      }
    }

    return queryParts.join('\n').trim();
  }

  private extractTextFromMessage(message: Message): string {
    for (const part of message.content) {
      if (part.type === 'text') {
        const text = (part as TextContent).text;
        if (text && text.trim()) {
          return text.trim();
        }
      }
    }
    return '';
  }

  private formatResults(results: any[], config: VectorContextConfig): string {
    const format = config.resultFormat ?? getVectorDefaults().resultFormat;

    const formattedLines = results.map(result => {
      return interpolate(format, {
        id: result.id,
        score: result.score,
        payload: result.payload ?? {}
      });
    });

    return formattedLines.join('\n');
  }

  private applyTemplate(content: string, config: VectorContextConfig, maxInjectedPayloadBytes?: number): string {
    const template = config.injectTemplate ?? getVectorDefaults().injectTemplate;
    const rendered = template.replace('{{results}}', content);
    if (typeof maxInjectedPayloadBytes !== 'number' || maxInjectedPayloadBytes <= 0) {
      return rendered;
    }
    return truncateUtf8Bytes(rendered, maxInjectedPayloadBytes);
  }

  private buildEmbeddingCacheKey(query: string, priority: Array<{ provider: string; model?: string }>): string {
    const normalizedPriority = priority
      .map(item => `${String(item.provider)}:${item.model ? String(item.model) : ''}`)
      .join('|');
    return `${query}::${normalizedPriority}`;
  }

  private injectIntoMessages(
    messages: Message[],
    context: string,
    injectAs: 'system' | 'user_context',
    systemPrompt?: string
  ): Message[] {
    const result = [...messages];

    if (injectAs === 'system') {
      const systemContent = systemPrompt
        ? `${systemPrompt}\n\n${context}`
        : context;

      const systemMessage: Message = {
        role: Role.SYSTEM,
        content: [{ type: 'text', text: systemContent }]
      };

      if (result.length > 0 && result[0].role === Role.SYSTEM) {
        const existingText = (result[0].content[0] as TextContent)?.text ?? '';
        result[0] = {
          ...result[0],
          content: [{ type: 'text', text: `${existingText}\n\n${context}` }]
        };
      } else {
        result.unshift(systemMessage);
      }
    } else {
      const contextMessage: Message = {
        role: Role.USER,
        content: [{ type: 'text', text: context }]
      };

      let lastUserIndex = -1;
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === Role.USER) {
          lastUserIndex = i;
          break;
        }
      }

      if (lastUserIndex >= 0) {
        result.splice(lastUserIndex, 0, contextMessage);
      } else {
        result.push(contextMessage);
      }
    }

    return result;
  }

  private async ensureManagers(): Promise<void> {
    if (!this.embeddingManager) {
      const { EmbeddingManager } = await import('../../embeddings/index.js');
      this.embeddingManager = new EmbeddingManager(this.registry as any, this.embeddingLogger);
    }
    if (!this.vectorManager) {
      this.vectorManager = new VectorStoreManager(
        new Map(),
        new Map(),
        undefined,
        this.registry,
        this.vectorLogger
      );
    }
  }

  private async ensureStoreInitialized(storeId: string): Promise<void> {
    const compat = await this.vectorManager!.getCompat(storeId);
    if (!compat) {
      throw new Error(`Vector store not available: ${storeId}`);
    }
  }
}
