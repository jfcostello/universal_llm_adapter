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
   * Only used by certain providers (e.g., Anthropic prompt caching).
   */
  providerOptions?: {
    anthropic?: {
      cacheControl?: {
        type: string;
      };
    };
    openrouter?: {
      plugin?: 'pdf-text' | 'mistral-ocr' | 'native';
    };
  };
}

export type ContentPart = TextContent | ImageContent | DocumentContent | ToolResultContent;

export interface ReasoningData {
  text: string;
  redacted?: boolean;
  metadata?: Record<string, any>; // Provider-specific metadata (e.g., Anthropic's signature)
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
   * Used to preserve cryptographic signatures (e.g., Google's thoughtSignature)
   * that must be sent back in subsequent requests.
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
  'reasoningBudget'
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
}

export interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  /** Cost in credits (OpenRouter usage accounting) */
  cost?: number;
  /** Tokens read from cache (OpenRouter/OpenAI prompt caching) */
  cachedTokens?: number;
  /** Audio tokens (OpenRouter/OpenAI) */
  audioTokens?: number;
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
 * Implemented by: plugins/embedding-compat/openrouter.ts, etc.
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
 * Implemented by: plugins/vector-compat/qdrant.ts, etc.
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
   * Used to preserve encrypted signatures (e.g., OpenRouter/Gemini reasoning.encrypted)
   * that must be sent back in subsequent requests for multi-turn tool conversations.
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
 * Root interface containing all default settings categories.
 * Loaded from plugins/configs/defaults.json
 */
export interface DefaultSettings {
  retry: RetryDefaults;
  tools: ToolDefaults;
  vector: VectorDefaults;
  chunking: ChunkingDefaults;
  tokenEstimation: TokenEstimationDefaults;
  timeouts: TimeoutDefaults;
  server: ServerDefaults;
  paths: PathDefaults;
}
