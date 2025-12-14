/**
 * Built-in handler for vector search tool execution.
 * Executes vector searches with server-side lock enforcement.
 */

import type { EmbeddingManager } from '../../embeddings/index.js';
import {
  VectorContextConfig,
  VectorQueryResult,
  JsonObject,
  PluginRegistry,
  getDefaults,
} from '../../kernel/index.js';
import { VectorStoreManager } from './vector-store-manager.js';
import {
  AdapterLogger,
  getLogger,
  getEmbeddingLogger,
  getVectorLogger
} from '../../logging/index.js';
import { interpolate } from '../../string/index.js';
import { resolveEmbeddingPriority } from './embedding-priority.js';

/**
 * Arguments provided by the LLM when calling vector search tool.
 */
export interface VectorSearchArgs {
  /** The search query (always required) */
  query: string;
  /** Number of results to return (optional if not locked) */
  topK?: number;
  /** Which store to search (optional if not locked) */
  store?: string;
  /** Metadata filter to constrain results (optional if not locked) */
  filter?: JsonObject;
  /** Collection to search (optional, usually hidden from schema unless explicitly exposed) */
  collection?: string;
  /** Minimum score threshold (optional, usually hidden from schema unless explicitly exposed) */
  scoreThreshold?: number;
}

/**
 * Context required for executing vector search.
 */
export interface VectorSearchHandlerContext {
  /** Vector context configuration including locks */
  vectorConfig: VectorContextConfig;
  /** Plugin registry for accessing stores and compats */
  registry: PluginRegistry;
  /** Optional embedding manager (will be created if not provided) */
  embeddingManager?: EmbeddingManager;
  /** Optional vector store manager (will be created if not provided) */
  vectorManager?: VectorStoreManager;
  /** Optional logger for diagnostics */
  logger?: AdapterLogger;
}

/**
 * Result returned from vector search execution.
 */
export interface VectorSearchResult {
  /** Whether the search succeeded */
  success: boolean;
  /** Search results (on success) */
  results?: VectorQueryResult[];
  /** Error message (on failure) */
  error?: string;
  /** The query that was executed */
  query: string;
  /** Effective parameters used (after lock enforcement) */
  effectiveParams: {
    store: string;
    collection: string;
    topK: number;
    scoreThreshold?: number;
    filter?: JsonObject;
  };
}

/**
 * Execute a vector search with server-side lock enforcement.
 * Locks always take precedence over LLM-provided arguments.
 */
export async function executeVectorSearch(
  args: VectorSearchArgs,
  context: VectorSearchHandlerContext
): Promise<VectorSearchResult> {
  const { vectorConfig, registry } = context;
  const locks = vectorConfig.locks;
  const logger = context.logger ?? getLogger();

  // Apply locks - locked values always take precedence, then args, then config defaults
  const effectiveStore = locks?.store ?? args.store ?? vectorConfig.stores[0];
  const effectiveTopK = locks?.topK ?? args.topK ?? vectorConfig.topK ?? getDefaults().vector.topK;
  const effectiveCollection = locks?.collection ?? args.collection ?? vectorConfig.collection;
  const effectiveScoreThreshold = locks?.scoreThreshold ?? args.scoreThreshold ?? vectorConfig.scoreThreshold;
  const effectiveFilter = locks?.filter ?? args.filter ?? vectorConfig.filter;

  logger.info('Executing vector search', {
    query: args.query,
    effectiveStore,
    effectiveTopK,
    effectiveCollection,
    hasScoreThreshold: effectiveScoreThreshold !== undefined,
    hasFilter: effectiveFilter !== undefined,
    lockedParams: Object.keys(locks ?? {})
  });

  try {
    // Ensure managers are initialized
    const embeddingLogger = getEmbeddingLogger();
    const vectorLogger = getVectorLogger();

    const embeddingManager = context.embeddingManager ??
      await createEmbeddingManager(registry, embeddingLogger);

    const ownsVectorManager = !context.vectorManager;
    const vectorManager = context.vectorManager ??
      new VectorStoreManager(new Map(), new Map(), undefined, registry, vectorLogger);

    try {
      // Embed the query
      const embeddingPriority = await resolveEmbeddingPriority(
        { explicit: vectorConfig.embeddingPriority, storeIds: [effectiveStore] },
        registry
      );
      const embeddingResult = await embeddingManager.embed(args.query, embeddingPriority);
      const queryVector = embeddingResult.vectors[0];

      // Ensure store config exists (for defaults) and compat is connected via manager-owned instance
      const storeConfig = await registry.getVectorStore(effectiveStore);
      const compat = await vectorManager.getCompat(effectiveStore);
      if (!compat) {
        throw new Error(`Vector store not available: ${effectiveStore}`);
      }

      // Determine collection
      const collection = effectiveCollection ?? storeConfig.defaultCollection ?? 'default';

      // Execute query
      let results = await compat.query(
        collection,
        queryVector,
        effectiveTopK,
        {
          filter: effectiveFilter,
          includePayload: true
        }
      );

      // Apply score threshold if set
      if (effectiveScoreThreshold !== undefined) {
        results = results.filter(r => r.score >= effectiveScoreThreshold);
      }

      logger.info('Vector search completed', {
        query: args.query,
        resultsCount: results.length,
        effectiveStore,
        collection
      });

      return {
        success: true,
        results,
        query: args.query,
        effectiveParams: {
          store: effectiveStore,
          collection,
          topK: effectiveTopK,
          scoreThreshold: effectiveScoreThreshold,
          filter: effectiveFilter
        }
      };
    } finally {
      if (ownsVectorManager) {
        await vectorManager.closeAll().catch(() => {});
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Vector search failed', {
      query: args.query,
      effectiveStore,
      error: errorMessage
    });

    return {
      success: false,
      error: errorMessage,
      query: args.query,
      effectiveParams: {
        store: effectiveStore,
        collection: effectiveCollection ?? 'unknown',
        topK: effectiveTopK,
        scoreThreshold: effectiveScoreThreshold,
        filter: effectiveFilter
      }
    };
  }
}

async function createEmbeddingManager(registry: PluginRegistry, logger: any): Promise<EmbeddingManager> {
  const { EmbeddingManager } = await import('../../embeddings/index.js');
  return new EmbeddingManager(registry as any, logger);
}

/**
 * Format vector search results for LLM consumption.
 * Returns a string that can be used as tool result.
 */
export function formatVectorSearchResults(
  result: VectorSearchResult,
  config?: VectorContextConfig
): string {
  if (!result.success) {
    return `Vector search failed: ${result.error}`;
  }

  if (!result.results || result.results.length === 0) {
    return `No results found for query: "${result.query}"`;
  }

  // Check if custom resultFormat is provided
  const customFormat = config?.resultFormat;

  const formatted = result.results.map((r, i) => {
    let content: string;

    if (customFormat) {
      // Use custom format with interpolation
      content = interpolate(customFormat, {
        id: r.id,
        score: r.score,
        payload: r.payload ?? {}
      });
    } else {
      // Default behavior: use payload.text (as string) or JSON stringify
      const textValue = r.payload?.text;
      content = typeof textValue === 'string' ? textValue : JSON.stringify(r.payload ?? {});
    }

    return `[${i + 1}] (score: ${r.score.toFixed(3)}) ${content}`;
  });

  return `Found ${result.results.length} results:\n${formatted.join('\n')}`;
}

