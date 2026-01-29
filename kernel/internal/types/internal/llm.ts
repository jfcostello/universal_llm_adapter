import type { ObservabilitySpec } from '../../observability-spec-types.js';

import type { ContentPart, Message, ReasoningData, Role } from './chat.js';
import type { JsonObject, JsonValue } from './json.js';
import type { LLMCallSettings, LLMPriorityItem } from './settings.js';
import type { ToolCall, ToolChoice, ToolRoutingSpec, UnifiedTool } from './tools.js';
import type { VectorContextConfig } from './vector-context.js';

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
  /** Optional adapter-side tool routing overrides for this call. */
  toolRouting?: ToolRoutingSpec;
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
