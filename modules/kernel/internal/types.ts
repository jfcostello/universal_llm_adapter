import type { ObservabilitySpec } from './observability-spec-types.js';

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject { [key: string]: JsonValue; }
export interface JsonArray extends Array<JsonValue> {}

export enum Role {
  SYSTEM = "system",
  USER = "user", 
  ASSISTANT = "assistant",
  TOOL = "tool"
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  imageUrl: string;
  mimeType?: string;
}

export interface ToolResultContent {
  type: "tool_result";
  toolName: string;
  result: JsonValue;
}

/**
 * Represents a document/file to be processed by the LLM.
 * Users provide file paths; the system loads, encodes, and transforms them.
 */
export interface DocumentContent {
  type: 'document';

  /**
   * Source of the document data.
   * - filepath: Local file path (will be loaded and converted to base64)
   * - base64: Already encoded base64 data
   * - url: Public URL to the document
   * - file_id: Provider-specific file ID from their Files API
   */
  source:
    | { type: 'filepath'; path: string }
    | { type: 'base64'; data: string }
    | { type: 'url'; url: string }
    | { type: 'file_id'; fileId: string };

  /**
   * MIME type of the document.
   * Examples: 'application/pdf', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
   * If not provided and source is filepath, will be auto-detected.
   */
  mimeType?: string;

  /**
   * Original filename (for logging, debugging, or provider requirements).
   * If not provided and source is filepath, will be extracted from path.
   */
  filename?: string;

  /**
   * Provider-specific options (optional).
   * Only used by certain provider plugins (e.g., caching controls, document processing hints).
   */
  providerOptions?: Record<string, any>;
}

export type ContentPart = TextContent | ImageContent | DocumentContent | ToolResultContent;

export interface ReasoningData {
  text: string;
  redacted?: boolean;
  metadata?: Record<string, any>; // Provider-specific metadata returned by the compat layer
}

export interface Message {
  role: Role;
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: ReasoningData;
}

export interface UnifiedTool {
  name: string;
  description?: string;
  parametersJsonSchema?: JsonObject;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
  /**
   * Alias for compatibility with existing tooling that expects `args`.
   * Always mirrors the value of `arguments`.
   */
  args?: JsonObject;
  /**
   * Provider-specific metadata for this tool call.
   * Used to preserve provider-supplied signatures that must be sent back in
   * subsequent requests.
   */
  metadata?: Record<string, any>;
}

export type ToolChoiceAuto = "auto" | "none";

export interface ToolChoiceSingle {
  type: "single";
  name: string;
}

export interface ToolChoiceRequired {
  type: "required";
  allowed: string[];
}

export type ToolChoice = ToolChoiceAuto | ToolChoiceSingle | ToolChoiceRequired;

export interface LLMCallSettings {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: string;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  logitBias?: Record<number, number>;
  logprobs?: boolean;
  topLogprobs?: number;
  reasoning?: {
    enabled?: boolean;
    effort?: 'high' | 'medium' | 'low' | 'minimal' | 'none' | 'xhigh';
    budget?: number;
    exclude?: boolean;
  };
  reasoningBudget?: number;
  toolCountdownEnabled?: boolean;
  toolFinalPromptEnabled?: boolean;
  maxToolIterations?: number;
  preserveToolResults?: number | 'all' | 'none';
  preserveReasoning?: number | 'all' | 'none';
  parallelToolExecution?: boolean;
  toolResultMaxChars?: number;
  batchId?: string;
  /** Enable optional usage cost calculation when provider omits cost */
  usageCost?: boolean;
  provider?: Record<string, any>;
  [key: string]: any;
}

export const RUNTIME_SETTING_KEYS = [
  'toolCountdownEnabled',
  'toolFinalPromptEnabled',
  'maxToolIterations',
  'preserveToolResults',
  'preserveReasoning',
  'parallelToolExecution',
  'toolResultMaxChars',
  'batchId'
] as const;

export type RuntimeSettingKey = typeof RUNTIME_SETTING_KEYS[number];
export type RuntimeSettings = Pick<LLMCallSettings, RuntimeSettingKey>;

export const PROVIDER_SETTING_KEYS = [
  'temperature',
  'topP',
  'maxTokens',
  'stop',
  'responseFormat',
  'seed',
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'logprobs',
  'topLogprobs',
  'reasoning',
  'reasoningBudget',
  'usageCost'
] as const;

export interface LLMPriorityItem {
  provider: string;
  model: string;
  /** Optional per-provider settings that override global settings via deep merge */
  settings?: Partial<LLMCallSettings>;
}

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

export interface LLMCallSpec {
  systemPrompt?: string;
  messages: Message[];
  functionToolNames?: string[];
  tools?: UnifiedTool[];
  mcpServers?: string[];
  vectorStores?: string[];
  /** @deprecated Use vectorContext instead. Used for semantic tool retrieval. */
  vectorPriority?: string[];
  /** Vector context configuration for RAG capabilities */
  vectorContext?: VectorContextConfig;
  llmPriority: LLMPriorityItem[];
  toolChoice?: ToolChoice;
  rateLimitRetryDelays?: number[];
  settings: LLMCallSettings;
  metadata?: JsonObject;
  /** Optional observability configuration for this call */
  observability?: ObservabilitySpec;
}

export interface UsageStats {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  reasoningTokens?: number | null;
  /** Optional cost returned by the provider */
  cost?: number | null;
  /** Tokens read from cache (if supported) */
  cachedTokens?: number | null;
  /** Audio tokens (if supported) */
  audioTokens?: number | null;
}

export interface LLMResponse {
  provider: string;
  model: string;
  role: Role;
  content: ContentPart[];
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: UsageStats;
  reasoning?: ReasoningData;
  raw?: JsonValue;
}

export interface EndpointConfig {
  urlTemplate: string;
  method: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  // Optional streaming-specific overrides for providers whose streaming uses a different endpoint
  streamingUrlTemplate?: string;
  streamingHeaders?: Record<string, string>;
  streamingQuery?: Record<string, string>;
}

export interface RealtimeEndpointConfig {
  urlTemplate: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
}

export interface RealtimeWebrtcEndpointConfig {
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface RealtimeClientSecretEndpointConfig {
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/**
 * Realtime provider manifest (loaded from JSON).
 *
 * This is intentionally separate from `ProviderManifest` so realtime providers
 * can be configured independently from standard LLM request/response providers.
 */
export interface RealtimeProviderManifest {
  id: string;
  compat: string;
  endpoint: RealtimeEndpointConfig;
  webrtc?: {
    endpoint: RealtimeWebrtcEndpointConfig;
    clientSecretEndpoint?: RealtimeClientSecretEndpointConfig;
  };
  metadata?: JsonObject;
}

export interface ProviderPayloadExtension {
  name: string;
  settingsKey: string;
  targetPath: string[];
  valueType: "any" | "object" | "array" | "string" | "number" | "boolean";
  mergeStrategy?: "update" | "replace";
  default?: JsonValue;
  required?: boolean;
  description?: string;
  schema?: JsonObject;
}

export interface ProviderManifest {
  id: string;
  compat: string;
  endpoint: EndpointConfig;
  retryWords?: string[];
  metadata?: JsonObject;
  payloadExtensions?: ProviderPayloadExtension[];
  /** Provider-specific default settings (e.g., maxTokens, reasoningBudget) */
  defaults?: JsonObject;
}

export interface MCPServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
  autoStart?: boolean;
  capabilities?: JsonObject;
  requestTimeoutMs?: number;
}

export interface VectorStoreConfig {
  id: string;
  kind: string;
  connection: JsonObject;
  defaultCollection?: string;
  /**
   * Default embedding priority for operations that require embeddings when the spec does not provide one.
   * Must reference embedding provider IDs from plugins/embeddings/*.json.
   */
  defaultEmbeddingPriority?: EmbeddingPriorityItem[];
  metadata?: JsonObject;
}

// ============================================================
// EMBEDDING TYPES
// ============================================================

/**
 * Configuration for an embedding provider (loaded from JSON)
 */
export interface EmbeddingProviderConfig {
  id: string;
  kind: string;
  endpoint: {
    urlTemplate: string;
    headers: Record<string, string>;
  };
  model: string;
  dimensions?: number;
  metadata?: JsonObject;
}

/**
 * Priority item for embedding - which provider/model to try
 */
export interface EmbeddingPriorityItem {
  provider: string;
  model?: string;
}

/**
 * Result from an embedding operation
 */
export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  tokenCount?: number;
}

// ============================================================
// OBSERVABILITY TYPES
// ============================================================

/**
 * Authentication configuration for observability providers.
 */
export interface ObservabilityAuthConfig {
  /**
   * Authentication type.
   * - basic: HTTP Basic Auth (public key as username, secret key as password)
   * - bearer: Bearer token
   * - header: Custom header-based auth
   */
  type: 'basic' | 'bearer' | 'header';

  /**
   * Environment variable name for the public key (basic auth username).
   */
  publicKeyEnv?: string;

  /**
   * Environment variable name for the secret key (basic auth password or bearer token).
   */
  secretKeyEnv?: string;

  /**
   * Custom header name (for header-based auth).
   */
  headerName?: string;

  /**
   * Environment variable name for custom header value.
   */
  headerValueEnv?: string;
}

/**
 * Provider limits for observability batching.
 */
export interface ObservabilityProviderLimits {
  /**
   * Maximum bytes per batch request.
   * Batches exceeding this are split.
   */
  maxBatchBytes?: number;
}

/**
 * Observability provider manifest (loaded from JSON).
 * Configures how to send events to an observability platform.
 */
export interface ObservabilityProviderManifest {
  /** Unique provider ID */
  id: string;

  /** Compat module name to use for building/sending payloads */
  compat: string;

  /** Endpoint configuration for ingestion */
  endpoint: {
    /** URL template for the ingestion endpoint */
    urlTemplate: string;
    /** HTTP method (typically POST) */
    method: string;
    /** Optional headers to include */
    headers?: Record<string, string>;
  };

  /** Authentication configuration */
  auth?: ObservabilityAuthConfig;

  /** Provider-specific limits */
  limits?: ObservabilityProviderLimits;

  /** Optional provider-specific defaults */
  defaults?: JsonObject;

  /** Optional metadata */
  metadata?: JsonObject;
}

/**
 * Outcome of sending an individual envelope to the observability provider.
 */
export interface ObservabilityEnvelopeOutcome {
  /** Envelope ID that was sent */
  envelopeId: string;

  /** Whether this envelope was accepted */
  success: boolean;

  /** HTTP status code for this envelope (if provider returns per-envelope status) */
  status?: number;

  /** Error message if failed */
  error?: string;

  /** Whether this failure is retryable */
  retryable?: boolean;
}

/**
 * Result from sending a batch to the observability provider.
 */
export interface ObservabilityBatchResult {
  /** Overall success (all envelopes accepted) */
  success: boolean;

  /** Per-envelope outcomes (for partial success responses like 207 Multi-Status) */
  outcomes: ObservabilityEnvelopeOutcome[];
}

/**
 * Optional context passed to observability compat modules.
 * This enables provider-specific runtime overrides without leaking provider logic into core modules.
 */
export interface ObservabilityCompatContext {
  /**
   * Provider-specific configuration overrides (opaque to core).
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Stable event IDs aligned with the `events[]` passed to `IObservabilityCompat.buildBatch()`.
   * Compat implementations can use these to generate deterministic envelope IDs for safe retries/deduping.
   */
  eventIds?: string[];

  /**
   * Timeout (ms) for provider export requests.
   * Compat implementations should enforce this via abort/timeout handling.
   */
  timeoutMs?: number;

  /**
   * Maximum UTF-8 bytes for any exported attribute string value.
   * Compat implementations should truncate large fields to stay within ingestion limits.
   */
  maxAttributeValueBytes?: number;
}

/**
 * Interface for observability compat modules.
 * Implementations translate provider-agnostic events into provider-specific payloads.
 */
export interface IObservabilityCompat {
  /**
   * Build a batch payload from events for sending to the provider.
   *
   * @param events - Provider-agnostic observability events
   * @param manifest - The provider manifest for configuration
   * @returns Object containing the payload and a mapping from event IDs to envelope IDs
   */
  buildBatch(
    events: unknown[],
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): {
    payload: unknown;
    /**
     * Maps each provider envelope ID (returned in `ObservabilityBatchResult.outcomes`)
     * to the source event index in the `events` array passed to `buildBatch()`.
     *
     * This allows the exporter to retry the correct subset of events on partial failures.
     */
    eventIndexByEnvelopeId: Map<string, number>;
  };

  /**
   * Send a batch payload to the observability provider.
   *
   * @param payload - The built payload from buildBatch
   * @param manifest - The provider manifest for configuration
   * @returns Batch result with per-envelope outcomes
   */
  sendBatch(
    payload: unknown,
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): Promise<ObservabilityBatchResult>;
}

// ============================================================
// VECTOR STORE TYPES
// ============================================================

/**
 * A point to store in a vector database
 */
export interface VectorPoint {
  id: string;
  vector: number[];
  payload?: JsonObject;
}

/**
 * Result from a vector similarity search
 */
export interface VectorQueryResult {
  id: string;
  score: number;
  payload?: JsonObject;
  vector?: number[];
}

/**
 * Options for vector queries
 */
export interface VectorQueryOptions {
  filter?: JsonObject;
  includeVector?: boolean;
  includePayload?: boolean;
}

// ============================================================
// COMPAT INTERFACES (implemented by plugins)
// ============================================================

export type LoggerCorrelationId = string | string[];

/**
 * Minimal, provider-agnostic logger interface for coordinator-level diagnostics.
 */
export interface IBaseLogger<TSelf> {
  withCorrelation(correlationId: LoggerCorrelationId): TSelf;
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warning(message: string, data?: any): void;
  error(message: string, data?: any): void;
  close(): Promise<void>;
}

/**
 * Logger interface for LLM request/response logging.
 */
export interface ILLMOperationLogger {
  logLLMRequest(data: {
    url: string;
    method: string;
    headers: Record<string, any>;
    body: any;
    provider?: string;
    model?: string;
  }): void;

  logLLMResponse(data: {
    status: number;
    statusText?: string;
    headers: Record<string, any>;
    body: any;
    duration?: number;
    provider?: string;
    model?: string;
  }): void;
}

/**
 * Backwards-compatible alias used by older code paths that expect a single logger.
 * This matches the shape implemented by the optional `modules/logging` module.
 */
export interface AdapterLogger extends IBaseLogger<AdapterLogger>, ILLMOperationLogger {}

/**
 * Logger interface for embedding compats.
 */
export interface IEmbeddingOperationLogger {
  logEmbeddingRequest(data: {
    url: string;
    method: string;
    headers: Record<string, any>;
    body: any;
    provider?: string;
    model?: string;
  }): void;

  logEmbeddingResponse(data: {
    status: number;
    statusText?: string;
    headers: Record<string, any>;
    body: any;
    dimensions?: number;
    tokenCount?: number;
  }): void;
}

/**
 * Logger interface for vector compats.
 */
export interface IVectorOperationLogger {
  logVectorRequest(data: {
    operation: string;
    store: string;
    collection?: string;
    params: Record<string, any>;
  }): void;

  logVectorResponse(data: {
    operation: string;
    store: string;
    collection?: string;
    result: any;
    duration?: number;
  }): void;
}

/**
 * Backwards-compatible alias used by older code paths that expect a single logger.
 */
export type IOperationLogger = IEmbeddingOperationLogger & IVectorOperationLogger;

/**
 * Interface for embedding compat modules.
 */
export interface IEmbeddingCompat {
  embed(
    input: string | string[],
    config: EmbeddingProviderConfig,
    model?: string,
    logger?: IEmbeddingOperationLogger
  ): Promise<EmbeddingResult>;

  getDimensions(config: EmbeddingProviderConfig, model?: string): number;

  validate?(config: EmbeddingProviderConfig): Promise<boolean>;
}

/**
 * Interface for vector store compat modules.
 */
export interface IVectorStoreCompat {
  /** Optional method to inject a logger for operation logging */
  setLogger?(logger: IVectorOperationLogger): void;

  connect(config: VectorStoreConfig): Promise<void>;

  close(): Promise<void>;

  query(
    collection: string,
    vector: number[],
    topK: number,
    options?: VectorQueryOptions
  ): Promise<VectorQueryResult[]>;

  upsert(collection: string, points: VectorPoint[]): Promise<void>;

  deleteByIds(collection: string, ids: string[]): Promise<void>;

  collectionExists(collection: string): Promise<boolean>;

  createCollection?(
    collection: string,
    dimensions: number,
    options?: JsonObject
  ): Promise<void>;

  listCollections?(): Promise<string[]>;

  deleteCollection?(collection: string): Promise<void>;
}

export interface ProcessMatchConfig {
  type: "exact" | "prefix" | "regex" | "glob";
  pattern: string;
}

export interface ProcessInvokeConfig {
  kind: "module" | "http" | "command" | "mcp";
  module?: string;
  function?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  server?: string;
}

export interface ProcessRouteManifest {
  id: string;
  match: ProcessMatchConfig;
  invoke: ProcessInvokeConfig;
  timeoutMs?: number;
  metadata?: JsonObject;
}

export enum ToolCallEventType {
  TOOL_CALL_START = "tool_call_start",
  TOOL_CALL_ARGUMENTS_DELTA = "tool_call_arguments_delta",
  TOOL_CALL_END = "tool_call_end",
  TOOL_RESULT = "tool_result"
}

export interface ToolCallEvent {
  type: ToolCallEventType;
  callId: string;
  name?: string;
  argumentsDelta?: string;
  arguments?: string;
  /**
   * Provider-specific metadata for this tool call event.
   * Used to preserve encrypted signatures that must be sent back in subsequent
   * requests for multi-turn tool conversations.
   */
  metadata?: Record<string, any>;
}

export enum StreamEventType {
  TOKEN = "token",
  DELTA = "delta",
  TOOL = "tool",
  DONE = "done",
  ERROR = "error"
}

export interface LLMStreamEvent {
  type: StreamEventType | string;
  text?: string;
  content?: string; // For delta events
  toolEvent?: ToolCallEvent;
  toolCall?: any; // For tool_call events
  response?: LLMResponse; // For DONE event
  metadata?: JsonObject;
}

export interface ParsedStreamChunk {
  text?: string;
  toolEvents?: ToolCallEvent[];
  finishedWithToolCalls?: boolean;
  usage?: UsageStats;
  reasoning?: ReasoningData;
  metadata?: JsonObject;
}

export interface ICompatModule {
  // HTTP-based methods (required for all compats)
  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any;
  parseResponse(raw: any, model: string): LLMResponse;
  parseStreamChunk(chunk: any): ParsedStreamChunk;
  getStreamingFlags(): any;
  serializeTools(tools: UnifiedTool[]): any;
  serializeToolChoice(choice?: ToolChoice): any;
  applyProviderExtensions?(payload: any, extensions: any): any;

  // SDK-based methods (optional - if present, LLMManager will use these instead of HTTP)
  callSDK?(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    logger?: any,
    headers?: Record<string, string>
  ): Promise<LLMResponse>;

  streamSDK?(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    logger?: any,
    headers?: Record<string, string>
  ): AsyncGenerator<ParsedStreamChunk>;
}

// ============================================================
// DEFAULT SETTINGS TYPES
// ============================================================

/**
 * Retry and rate limiting default settings.
 */
export interface RetryDefaults {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
  rateLimitDelays: number[];
}

/**
 * Tool execution default settings.
 */
export interface ToolDefaults {
  countdownEnabled: boolean;
  finalPromptEnabled: boolean;
  parallelExecution: boolean;
  preserveResults: number;
  preserveReasoning: number;
  maxIterations: number;
  timeoutMs: number;
}

/**
 * Vector store and retrieval default settings.
 */
/**
 * Settings for constructing the embedding query from conversation messages.
 */
export interface QueryConstructionSettings {
  /**
   * Whether to include the system prompt in the embedding query.
   * - 'always': Always include system prompt
   * - 'never': Never include system prompt
   * - 'if-in-range': Include only if messagesToInclude covers the system message
   */
  includeSystemPrompt: 'always' | 'never' | 'if-in-range';

  /**
   * Whether to include assistant messages in the embedding query.
   */
  includeAssistantMessages: boolean;

  /**
   * Number of messages to include in the embedding query.
   * 0 = all messages, 1 = most recent only, 2 = last 2 messages, etc.
   */
  messagesToInclude: number;
}

export interface VectorDefaults {
  topK: number;
  injectTemplate: string;
  resultFormat: string;
  batchSize: number;
  includePayload: boolean;
  includeVector: boolean;
  defaultCollection: string;
  queryConstruction: QueryConstructionSettings;
}

/**
 * Text chunking default settings.
 */
export interface ChunkingDefaults {
  size: number;
  overlap: number;
}

/**
 * Token estimation default settings.
 */
export interface TokenEstimationDefaults {
  textDivisor: number;
  imageEstimate: number;
  toolResultDivisor: number;
}

/**
 * Timeout default settings (all values in milliseconds).
 */
export interface TimeoutDefaults {
  mcpRequest: number;
  llmHttp: number;
  embeddingHttp: number;
  loggerFlush: number;
}

/**
 * Server (HTTP/SSE) default settings.
 */
export interface ServerAuthDefaults {
  enabled: boolean;
  allowBearer: boolean;
  allowApiKeyHeader: boolean;
  headerName: string;
  apiKeys: string[] | string;
  hashedKeys: string[] | string;
  realm?: string;
}

export interface ServerRateLimitDefaults {
  enabled: boolean;
  requestsPerMinute: number;
  burst: number;
  trustProxyHeaders: boolean;
}

export interface ServerCorsDefaults {
  enabled: boolean;
  allowedOrigins: string[] | '*';
  allowedHeaders: string[];
  allowCredentials: boolean;
}

export interface ServerDefaults {
  maxRequestBytes: number;
  bodyReadTimeoutMs: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxConcurrentRequests: number;
  maxConcurrentStreams: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  maxConcurrentVectorRequests: number;
  maxConcurrentVectorStreams: number;
  vectorMaxQueueSize: number;
  vectorQueueTimeoutMs: number;
  maxConcurrentEmbeddingRequests: number;
  embeddingMaxQueueSize: number;
  embeddingQueueTimeoutMs: number;
  auth: ServerAuthDefaults;
  rateLimit: ServerRateLimitDefaults;
  cors: ServerCorsDefaults;
  securityHeadersEnabled: boolean;
}

/**
 * Path default settings.
 */
export interface PathDefaults {
  plugins: string;
}

/**
 * Observability default settings.
 * Controls optional export of LLM request/response data to observability platforms.
 */
export interface ObservabilityDefaults {
  /**
   * Whether observability is enabled globally.
   * Individual calls can override this via spec.observability.enabled.
   * @default false
   */
  enabled: boolean;

  /**
   * Default observability provider ID.
   * Must match an ID from plugins/observability-providers/*.json.
   */
  provider?: string;

  /**
   * Number of events to accumulate before triggering a flush.
   * @default 10
   */
  flushAt: number;

  /**
   * Maximum interval (ms) between flushes.
   * @default 5000
   */
  flushIntervalMs: number;

  /**
   * Maximum number of events to hold in the queue.
   * When exceeded, oldest events are dropped with a warning.
   * @default 1000
   */
  maxQueueSize: number;

  /**
   * Maximum retry attempts for failed exports.
   * @default 3
   */
  maxAttempts: number;

  /**
   * Base delay (ms) for exponential backoff on retries.
   * @default 250
   */
  baseDelayMs: number;

  /**
   * Maximum delay (ms) cap for exponential backoff.
   * @default 30000
   */
  maxDelayMs: number;

  /**
   * HTTP request timeout (ms) for export requests.
   * @default 10000
   */
  timeoutMs: number;

  /**
   * Maximum UTF-8 bytes for any exported attribute string value.
   * Provider compats should truncate large fields to stay within ingestion limits.
   * @default 16384
   */
  maxAttributeValueBytes: number;

  /**
   * Capture level for message/content bodies.
   * - none: do not export prompt/response bodies
   * - text: export only text content parts (exclude tool results/doc blobs)
   * - full: export full structured message/content payloads
   * @default 'none'
   */
  captureMessages: 'none' | 'text' | 'full';

  /**
   * Whether to export tool-call arguments/metadata.
   * @default false
   */
  captureToolArgs: boolean;

  /**
   * Whether to export the final provider request payload (`requestPayload`).
   * @default false
   */
  captureRequestPayload: boolean;

  /**
   * Whether to export raw provider response payloads when available (`rawResponse`).
   * @default false
   */
  captureRawResponse: boolean;

  /**
   * Sampling rate (0..1). When < 1, calls may be skipped entirely.
   * @default 1
   */
  sampleRate: number;

  /**
   * Maximum UTF-8 bytes for aggregated input text exported by providers/compats.
   * @default 4096
   */
  maxInputTextBytes: number;

  /**
   * Maximum UTF-8 bytes for aggregated output text exported by providers/compats.
   * @default 4096
   */
  maxOutputTextBytes: number;

  /**
   * Maximum UTF-8 bytes for JSON-like serialized attributes (e.g. observation input/output).
   * @default 8192
   */
  maxJsonBytes: number;
}

/**
 * Root interface containing all default settings categories.
 * Loaded from plugins/configs/defaults.json
 */
export interface DefaultSettings {
  retry: RetryDefaults;
  tools: ToolDefaults;
  usageCost: boolean;
  vector: VectorDefaults;
  chunking: ChunkingDefaults;
  tokenEstimation: TokenEstimationDefaults;
  timeouts: TimeoutDefaults;
  server: ServerDefaults;
  paths: PathDefaults;
  observability: ObservabilityDefaults;
}
