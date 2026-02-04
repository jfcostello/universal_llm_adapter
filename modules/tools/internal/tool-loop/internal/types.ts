import type { PluginRegistry } from '../../../../../kernel/index.js';
import type {
  LLMResponse,
  LLMStreamEvent,
  Message,
  ProviderManifest,
  ToolCall,
  ToolChoice,
  UnifiedTool,
  RuntimeSettings,
  UsageStats,
  ReasoningData,
  AdapterLogger
} from '../../../../../kernel/index.js';
import type { LLMManager } from '../../../../llm/index.js';

export interface BaseToolLoopOptions {
  llmManager: LLMManager;
  registry: PluginRegistry;
  messages: Message[];
  tools: UnifiedTool[];
  toolChoice?: ToolChoice;
  providerManifest: ProviderManifest;
  model: string;
  runtime: RuntimeSettings;
  providerSettings: Record<string, any>;
  providerExtras: Record<string, any>;
  logger: AdapterLogger;
  toolNameMap: Record<string, string>;
  runContext?: any;
  metadata?: Record<string, any>;
}

export interface NonStreamToolLoopOptions extends BaseToolLoopOptions {
  mode: 'nonstream';
  initialResponse: LLMResponse;
  invokeTool: InvokeToolFn;
}

export interface StreamToolLoopOptions extends BaseToolLoopOptions {
  mode: 'stream';
  initialToolCalls: ToolCall[];
  initialReasoning?: ReasoningData;
  invokeTool: InvokeToolFn;
  /**
   * Observability generation id for the parent streaming attempt.
   * When provided, tool execution events can be nested under the generation span.
   */
  observabilityGenerationId?: string;
}

export type InvokeToolFn = (
  toolName: string,
  call: ToolCall,
  context: ToolInvocationContext
) => Promise<any>;

export interface ToolInvocationContext {
  provider: string;
  model: string;
  metadata?: Record<string, any>;
  logger: AdapterLogger;
  callProgress?: Record<string, any>;
}

export interface StreamLoopResult {
  content?: string;
  usage?: UsageStats;
  reasoning?: ReasoningData;
  toolCalls?: ToolCall[];
  finishReason?: string;
}

export type ToolLoopStreamGenerator = AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined>;
