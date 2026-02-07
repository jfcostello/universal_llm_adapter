import type { EmbeddingPriorityItem } from './embedding-types.js';
import type { QueryConstructionSettings } from './defaults.js';
import type { JsonObject } from './json.js';

/**
 * Parameters that can be locked for vector search tool calls.
 * Locked parameters are hidden from the LLM schema and enforced server-side.
 * When a parameter is locked, the LLM cannot override it.
 */
export interface VectorSearchLocks {
  /** Lock to a specific store - LLM cannot choose a different store */
  store?: string;
  /** Lock number of results - LLM cannot request more or fewer results */
  topK?: number;
  /** Lock metadata filter - LLM cannot modify filter criteria */
  filter?: JsonObject;
  /** Lock minimum score threshold - LLM cannot lower the quality bar */
  scoreThreshold?: number;
  /** Lock collection - LLM cannot query a different collection */
  collection?: string;
}

/**
 * Override configuration for a single tool parameter in the schema.
 * Allows customizing name, description, and visibility of parameters.
 */
export interface ToolSchemaParamOverride {
  /**
   * Exposed name (what LLM sees in the schema).
   * If omitted, uses the canonical parameter name.
   */
  name?: string;
  /**
   * Override the parameter description.
   * If omitted, uses the default description.
   */
  description?: string;
  /**
   * Whether to expose this parameter in the schema.
   * Defaults vary by parameter:
   * - query, topK, store, filter: true (exposed by default)
   * - collection, scoreThreshold: false (hidden by default)
   * Note: Locked parameters are always hidden regardless of this setting.
   */
  expose?: boolean;
}

/**
 * Schema overrides for the vector_search tool.
 * Allows customizing parameter names, descriptions, and exposure.
 * This enables domain-specific or user-friendly parameter labels
 * while preserving the adapter's internal semantics.
 */
export interface ToolSchemaOverrides {
  /** Override the tool description */
  toolDescription?: string;
  /**
   * Per-parameter overrides, keyed by canonical parameter name.
   * Supported parameters: query, topK, store, filter, collection, scoreThreshold
   */
  params?: {
    query?: ToolSchemaParamOverride;
    topK?: ToolSchemaParamOverride;
    store?: ToolSchemaParamOverride;
    filter?: ToolSchemaParamOverride;
    collection?: ToolSchemaParamOverride;
    scoreThreshold?: ToolSchemaParamOverride;
  };
}

/**
 * Configuration for vector-based context retrieval and injection.
 * Used in LLMCallSpec to enable RAG capabilities.
 */
export interface VectorContextConfig {
  /**
   * Vector stores to query, in priority order.
   * Must match IDs from plugins/vector/*.json
   */
  stores: string[];

  /**
   * Collection to query. Overrides defaultCollection from store config.
   * If not specified, uses the store's defaultCollection.
   */
  collection?: string;

  /**
   * How to use vector search results:
   * - 'auto': Query before LLM call, inject results into context
   * - 'tool': Create a vector_search tool the LLM can call
   * - 'both': Auto-inject initial context + provide tool for follow-ups
   */
  mode: 'tool' | 'auto' | 'both';

  /**
   * Number of results to retrieve. Default: 5
   */
  topK?: number;

  /**
   * Minimum similarity score (0-1). Results below this are filtered out.
   */
  scoreThreshold?: number;

  /**
   * Metadata filters to apply to the query.
   */
  filter?: JsonObject;

  /**
   * Which embedding provider(s) to use for query embedding.
   * Falls back through priority list on errors.
   */
  embeddingPriority?: EmbeddingPriorityItem[];

  // ========================================
  // Auto-inject mode configuration
  // ========================================

  /**
   * Where to inject retrieved context:
   * - 'system': Append to system prompt
   * - 'user_context': Insert as a user message before the last user message
   * Default: 'system'
   */
  injectAs?: 'system' | 'user_context';

  /**
   * Template for formatting retrieved results.
   * Use {{results}} placeholder for the formatted results.
   * Default: "Relevant context:\n{{results}}"
   */
  injectTemplate?: string;

  /**
   * Maximum tokens to include in injected context.
   * Results are truncated if they exceed this limit.
   */
  maxContextTokens?: number;

  /**
   * Format for each result in the context.
   * Default: "- {{payload.text}} (score: {{score}})"
   */
  resultFormat?: string;

  // ========================================
  // Tool mode configuration
  // ========================================

  /**
   * Name for the vector search tool. Default: 'vector_search'
   */
  toolName?: string;

  /**
   * Description for the vector search tool.
   * Default: "Search for relevant information in the knowledge base"
   */
  toolDescription?: string;

  /**
   * Schema overrides for customizing parameter names, descriptions, and exposure.
   * Use this to create domain-specific or user-friendly parameter labels.
   * Example: Rename 'topK' to 'max_results' or expose 'collection' as 'category'.
   */
  toolSchemaOverrides?: ToolSchemaOverrides;

  // ========================================
  // Parameter locking configuration
  // ========================================

  /**
   * Lock specific parameters so the LLM cannot override them.
   * Locked parameters are hidden from the tool schema and enforced server-side.
   * Use this to constrain LLM behavior for security or consistency.
   */
  locks?: VectorSearchLocks;

  // ========================================
  // Query construction configuration
  // ========================================

  /**
   * Override the embedding query with a custom string.
   * When provided, bypasses all message extraction logic and uses this string directly.
   */
  overrideEmbeddingQuery?: string;

  /**
   * Settings for constructing the embedding query from conversation messages.
   * Only used when overrideEmbeddingQuery is not provided.
   */
  queryConstruction?: Partial<QueryConstructionSettings>;
}

/**
 * Request-scoped performance guardrails for auto vector context injection.
 */
export interface VectorRequestPolicy {
  /**
   * Max number of auto/both contexts to execute per request.
   */
  maxAutoContexts: number;

  /**
   * Timeout budget for each individual auto context retrieval.
   */
  perContextTimeoutMs: number;

  /**
   * Total timeout budget shared across all auto contexts in a request.
   */
  totalAutoBudgetMs: number;

  /**
   * Max UTF-8 bytes injected into prompt context for each auto context.
   */
  maxInjectedPayloadBytes: number;
}
