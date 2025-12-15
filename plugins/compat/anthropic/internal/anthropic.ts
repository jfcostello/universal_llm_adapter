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
} from '../../../../modules/kernel/index.js';
import { Role } from '../../../../modules/kernel/index.js';
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

    const thinkingEnabled = thinkingRequested && allAssistantMessagesHaveReasoning;

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
      const budget = reasoning.budget || settings.reasoningBudget || 51200;
      payload.thinking = {
        type: 'enabled',
        budget_tokens: budget
      };
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

