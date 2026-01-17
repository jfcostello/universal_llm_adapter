import type { Message, ReasoningData } from './chat.js';
import type { EmbeddingProviderConfig, EmbeddingResult } from './embedding-types.js';
import type { JsonObject } from './json.js';
import type { LLMResponse, UsageStats } from './llm.js';
import type { LLMCallSettings } from './settings.js';
import type { ToolChoice, UnifiedTool } from './tools.js';
import type { VectorPoint, VectorQueryOptions, VectorQueryResult, VectorStoreConfig } from './vector-store-types.js';

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
   * Tool output text as surfaced to the model (may be truncated based on settings/tool budgets).
   * Present for TOOL_RESULT events emitted by the adapter tool loop.
   */
  resultText?: string;
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
