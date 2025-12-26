import type {
  ContentPart,
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
import { applyProviderExtensions } from './extensions.js';
import { hasPDFDocuments, serializeContent, serializeMessages } from './messages.js';
import { parseResponse as parseOpenAIResponse } from './response.js';
import { serializeSettings } from './settings.js';
import {
  createOpenAIStreamState,
  extractReasoningFromDelta,
  normalizeUsageStats,
  parseStreamChunk
} from './stream.js';
import { serializeToolChoice, serializeTools } from './tools.js';

export default class OpenAICompat implements ICompatModule {
  private streamState = createOpenAIStreamState();

  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const payload: any = {
      model,
      messages: serializeMessages(messages),
      ...serializeSettings(settings),
      ...this.serializeTools(tools),
      ...(hasTools ? this.serializeToolChoice(toolChoice) : {})
    };

    // Auto-detect PDF documents and add plugins configuration.
    if (hasPDFDocuments(messages)) {
      payload.plugins = [
        {
          id: 'file-parser',
          pdf: {
            engine: 'pdf-text'
          }
        }
      ];
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
    return parseOpenAIResponse(raw, model);
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    return parseStreamChunk(chunk, this.streamState);
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  applyProviderExtensions(payload: any, extensions: any): any {
    return applyProviderExtensions(payload, extensions);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeContent(parts: ContentPart[]): any[] {
    return serializeContent(parts);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private normalizeUsageStats(raw: any): UsageStats {
    return normalizeUsageStats(raw);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractReasoningFromDelta(delta: any): ReasoningData | undefined {
    return extractReasoningFromDelta(delta);
  }
}
