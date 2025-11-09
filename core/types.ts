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

export type ContentPart = TextContent | ImageContent | ToolResultContent;

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
    enabled: boolean;
    budget?: number;
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
}

export interface LLMCallSpec {
  systemPrompt?: string;
  messages: Message[];
  functionToolNames?: string[];
  tools?: UnifiedTool[];
  mcpServers?: string[];
  vectorStores?: string[];
  vectorPriority?: string[];
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
  metadata?: JsonObject;
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
