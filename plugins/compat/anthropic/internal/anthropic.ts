import type {
  ICompatModule,
  LLMCallSettings,
  LLMResponse,
  Message,
  ParsedStreamChunk,
  ReasoningData,
  ToolChoice,
  UnifiedTool,
  UsageStats
} from '../../../../kernel/index.js';
import { Role } from '../../../../kernel/index.js';
import { serializeMessages } from './messages.js';
import { parseResponse as parseAnthropicResponse } from './response.js';
import { serializeSettings } from './settings.js';
import {
  createAnthropicStreamState,
  extractReasoning,
  extractUsageStats,
  parseStreamChunk
} from './stream.js';
import { serializeToolChoice, serializeTools } from './tools.js';

export default class AnthropicCompat implements ICompatModule {
  private streamState = createAnthropicStreamState();

  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    const systemMessage = messages.find(m => m.role === Role.SYSTEM);
    const nonSystemMessages = messages.filter(m => m.role !== Role.SYSTEM);
    const systemPrompt = systemMessage
      ? systemMessage.content
          .filter(part => part.type === 'text' && typeof (part as any).text === 'string')
          .map(part => (part as any).text)
          .join('')
      : undefined;

    const reasoning = settings.reasoning;
    const thinkingRequested = reasoning?.enabled ?? false;
    const allAssistantMessagesHaveReasoning = nonSystemMessages
      .filter(m => m.role === Role.ASSISTANT)
      .every(m => m.reasoning && !m.reasoning.redacted);

    const toolChoiceForcesToolUse =
      typeof toolChoice === 'object' && (toolChoice.type === 'required' || toolChoice.type === 'single');

    const thinkingEnabled = thinkingRequested && allAssistantMessagesHaveReasoning && !toolChoiceForcesToolUse;

    const anthropicMessages = serializeMessages(nonSystemMessages);

    const payload: any = {
      model,
      max_tokens: settings.maxTokens ?? 8192,
      messages: anthropicMessages,
      ...serializeSettings(settings),
      ...this.serializeTools(tools),
      ...this.serializeToolChoice(toolChoice)
    };

    if (systemPrompt !== undefined) {
      payload.system = systemPrompt;
    }

    if (thinkingEnabled && reasoning) {
      const MIN_BUDGET_TOKENS = 1024;

      const requestedBudgetTokens = reasoning.budget || settings.reasoningBudget || 51200;
      const normalizedBudgetTokens = Math.max(requestedBudgetTokens, MIN_BUDGET_TOKENS);

      let maxTokens = payload.max_tokens;

      if (maxTokens <= MIN_BUDGET_TOKENS) {
        // Anthropic requires: max_tokens > thinking.budget_tokens (and budget_tokens >= 1024).
        // If the caller requested too few tokens, bump max_tokens to the minimum valid value.
        maxTokens = MIN_BUDGET_TOKENS + 1;
        payload.max_tokens = maxTokens;
      }

      const budgetTokens = Math.min(normalizedBudgetTokens, maxTokens - 1);
      payload.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens
      };

      if (payload.temperature !== undefined && payload.temperature !== 1) {
        payload.temperature = 1;
      }
    }

    return payload;
  }

  serializeTools(tools: UnifiedTool[]): any {
    return serializeTools(tools);
  }

  serializeToolChoice(choice?: ToolChoice): any {
    return serializeToolChoice(choice);
  }

  parseResponse(raw: any, model: string): LLMResponse {
    return parseAnthropicResponse(raw, model);
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    return parseStreamChunk(chunk, this.streamState);
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  applyProviderExtensions(payload: any, _extensions: any): any {
    return payload;
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractUsageStats(chunk: any): UsageStats | undefined {
    return extractUsageStats(chunk);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractReasoning(chunk: any): ReasoningData | undefined {
    return extractReasoning(chunk);
  }
}
