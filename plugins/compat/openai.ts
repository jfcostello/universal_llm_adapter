import {
  ICompatModule,
  LLMCallSettings,
  Message,
  UnifiedTool,
  ToolChoice,
  LLMResponse,
  Role,
  ContentPart,
  TextContent,
  ToolCall,
  ToolCallEvent,
  ToolCallEventType,
  UsageStats,
  ReasoningData,
  ParsedStreamChunk
} from '../../core/types.js';

export default class OpenAICompat implements ICompatModule {
  // Track tool call state across stream chunks
  private toolCallState = new Map<string, { name?: string; arguments: string }>();
  // Track if we've seen tool calls in the current stream
  private sawToolCallsInCurrentChunk = false;
  // Map index to id for OpenAI streaming (index -> id mapping)
  private indexToIdMap = new Map<number, string>();

  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    const payload: any = {
      model,
      messages: this.serializeMessages(messages),
      ...this.serializeSettings(settings),
      ...this.serializeTools(tools),
      ...this.serializeToolChoice(toolChoice)
    };

    return payload;
  }

  private serializeMessages(messages: Message[]): any[] {
    const serialized = messages.map((message, index) => {
      const ser: any = {
        role: message.role
      };

      if (message.toolCallId) {
        ser.tool_call_id = message.toolCallId;
      }

      if (message.toolCalls) {
        ser.tool_calls = message.toolCalls.map(call => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }
        }));
      }

      if (message.name) {
        // Sanitize name to match OpenAI pattern: ^[a-zA-Z0-9_-]+$
        const sanitizedName = message.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (process.env.LLM_LIVE === '1') {
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'debug',
            message: 'Sanitizing message name',
            data: {
              index,
              originalName: message.name,
              sanitizedName
            }
          }));
        }
        ser.name = sanitizedName;
      }

      // Add reasoning if present and not redacted
      // If redacted, omit entirely (OpenAI behavior)
      if (message.reasoning && !message.reasoning.redacted) {
        ser.reasoning = message.reasoning.text;
      }

      const contentParts = this.serializeContent(message.content);
      ser.content = contentParts.length > 0 ? contentParts :
        (message.role === Role.ASSISTANT || message.role === Role.TOOL ? "" : []);

      return ser;
    });

    if (process.env.LLM_LIVE === '1') {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'debug',
        message: 'Serialized messages',
        data: { messages: serialized }
      }));
    }

    return serialized;
  }

  private serializeContent(parts: ContentPart[]): any[] {
    return parts.map(part => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text };
      }
      if (part.type === 'image') {
        return {
          type: 'image_url',
          image_url: { url: part.imageUrl }
        };
      }
      if (part.type === 'document') {
        // OpenAI file format
        const fileBlock: any = {
          type: 'file',
          file: {}
        };

        if (part.source.type === 'base64') {
          // OpenAI requires data URL format for base64
          const dataUrl = `data:${part.mimeType};base64,${part.source.data}`;
          fileBlock.file = {
            filename: part.filename || 'document',
            file_data: dataUrl
          };
        } else if (part.source.type === 'url') {
          // OpenAI Chat Completions doesn't support direct URLs
          throw new Error('OpenAI Chat Completions does not support file URLs. Use file_id or base64.');
        } else if (part.source.type === 'file_id') {
          fileBlock.file = {
            file_id: part.source.fileId
          };
        }

        return fileBlock;
      }
      return null;
    }).filter(Boolean);
  }

  private serializeSettings(settings: LLMCallSettings): any {
    const result: any = {};

    if (settings.temperature !== undefined) {
      result.temperature = settings.temperature;
    }
    if (settings.topP !== undefined) {
      result.top_p = settings.topP;
    }
    if (settings.maxTokens !== undefined) {
      result.max_tokens = settings.maxTokens;
    }
    if (settings.stop) {
      result.stop = settings.stop;
    }
    if (settings.responseFormat) {
      result.response_format = { type: settings.responseFormat };
    }
    if (settings.seed !== undefined) {
      result.seed = settings.seed;
    }
    if (settings.frequencyPenalty !== undefined) {
      result.frequency_penalty = settings.frequencyPenalty;
    }
    if (settings.presencePenalty !== undefined) {
      result.presence_penalty = settings.presencePenalty;
    }
    if (settings.logitBias !== undefined) {
      result.logit_bias = settings.logitBias;
    }
    if (settings.logprobs !== undefined) {
      result.logprobs = settings.logprobs;
    }
    if (settings.topLogprobs !== undefined) {
      result.top_logprobs = settings.topLogprobs;
    }

    return result;
  }

  serializeTools(tools: UnifiedTool[]): any {
    if (!tools || tools.length === 0) {
      return {};
    }

    return {
      tools: tools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parametersJsonSchema || {
            type: "object",
            properties: {}
          }
        }
      }))
    };
  }

  serializeToolChoice(choice?: ToolChoice): any {
    if (!choice) return {};
    
    if (typeof choice === 'string') {
      return { tool_choice: choice };
    }
    
    if (choice.type === 'single') {
      return {
        tool_choice: {
          type: "function",
          function: { name: choice.name }
        }
      };
    }
    
    if (choice.type === 'required') {
      if (choice.allowed.length === 1) {
        return {
          tool_choice: {
            type: "function",
            function: { name: choice.allowed[0] }
          }
        };
      } else {
        return {
          tool_choice: "required",
          allowed_tools: choice.allowed
        };
      }
    }

    return {};
  }

  parseResponse(raw: any, model: string): LLMResponse {
    const choice = (raw.choices || [{}])[0];
    const message = choice.message || {};

    const content: ContentPart[] = this.parseContent(message.content);
    const toolCalls = this.parseToolCalls(message.tool_calls);
    const usage = this.parseUsage(raw.usage);
    const reasoning = this.parseReasoning(message);

    return {
      provider: raw.provider || 'openai',
      model: model,
      role: Role.ASSISTANT,
      content: content.length > 0 ? content : [{ type: 'text', text: '' } as TextContent],
      toolCalls,
      finishReason: choice.finish_reason,
      usage,
      reasoning,
      raw
    };
  }

  private parseContent(content: any): ContentPart[] {
    if (!content) return [];
    
    if (typeof content === 'string') {
      return [{ type: 'text', text: content } as TextContent];
    }
    
    if (Array.isArray(content)) {
      return content.map(part => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text || '' } as TextContent;
        }
        return null;
      }).filter(Boolean) as ContentPart[];
    }
    
    return [];
  }

  private parseToolCalls(rawCalls: any): ToolCall[] | undefined {
    if (!rawCalls || !Array.isArray(rawCalls)) {
      return undefined;
    }
    
    return rawCalls.map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name || '',
      arguments: JSON.parse(call.function?.arguments || '{}')
    }));
  }

  private parseUsage(usage: any): UsageStats | undefined {
    if (!usage) return undefined;

    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens
    };
  }

  private parseReasoning(message: any): ReasoningData | undefined {
    if (!message.reasoning && !message.reasoning_details) return undefined;

    // Extract reasoning text from message.reasoning or reasoning_details
    let reasoningText: string | undefined;

    if (message.reasoning) {
      reasoningText = message.reasoning;
    } else if (message.reasoning_details) {
      // Find the reasoning.summary entry in reasoning_details
      const summaryDetail = message.reasoning_details.find(
        (detail: any) => detail.type === 'reasoning.summary'
      );
      if (summaryDetail?.summary) {
        reasoningText = summaryDetail.summary;
      }
    }

    if (!reasoningText) return undefined;

    return {
      text: reasoningText
    };
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    const result: ParsedStreamChunk = {};

    const choices = chunk.choices || [];
    if (choices.length === 0) return result;

    const choice = choices[0];
    const delta = choice.delta || {};

    // Extract text content from delta
    if (delta.content) {
      result.text = delta.content;
    }

    // Track if we saw tool calls in this chunk
    this.sawToolCallsInCurrentChunk = false;

    // Extract tool call events from delta
    if (delta.tool_calls) {
      this.sawToolCallsInCurrentChunk = true;
      result.toolEvents = [];
      for (const toolCall of delta.tool_calls) {
        // Handle index -> id mapping for OpenAI streaming
        // First chunk has both id and index, later chunks may only have index
        if (toolCall.id && toolCall.index !== undefined) {
          this.indexToIdMap.set(toolCall.index, toolCall.id);
        }

        // Resolve callId: use id if present, else look up from index mapping, else use index
        let callId = toolCall.id;
        if (!callId && toolCall.index !== undefined) {
          callId = this.indexToIdMap.get(toolCall.index) || toolCall.index;
        }

        const state = this.toolCallState.get(callId) || { arguments: '' };

        if (toolCall.function?.name && !state.name) {
          state.name = toolCall.function.name;
          this.toolCallState.set(callId, state);

          result.toolEvents.push({
            type: ToolCallEventType.TOOL_CALL_START,
            callId,
            name: state.name
          });
        }

        if (toolCall.function?.arguments) {
          state.arguments += toolCall.function.arguments;

          result.toolEvents.push({
            type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
            callId,
            argumentsDelta: toolCall.function.arguments
          });
        }
      }
    }

    // Emit END events when stream finishes with tool calls
    // Only emit if we saw tool_calls in THIS chunk (not from previous tests/streams)
    if (choice.finish_reason === 'tool_calls') {
      result.finishedWithToolCalls = true;

      if (!result.toolEvents) {
        result.toolEvents = [];
      }

      // Only emit END events if we saw tool calls in the current chunk AND have pending state
      if (this.sawToolCallsInCurrentChunk && this.toolCallState.size > 0) {
        for (const [callId, state] of this.toolCallState.entries()) {
          result.toolEvents.push({
            type: ToolCallEventType.TOOL_CALL_END,
            callId,
            name: state.name,
            arguments: state.arguments
          });
        }
      }

      // Always clear state when we see finish_reason to reset for next stream
      this.toolCallState.clear();
      this.indexToIdMap.clear();
      this.sawToolCallsInCurrentChunk = false;
    }

    // Also clear state if we see other finish reasons to reset for next stream
    if (choice.finish_reason && choice.finish_reason !== 'tool_calls') {
      this.toolCallState.clear();
      this.indexToIdMap.clear();
      this.sawToolCallsInCurrentChunk = false;
    }

    if (chunk.usage) {
      result.usage = this.normalizeUsageStats(chunk.usage);
    }

    const reasoning = this.extractReasoningFromDelta(delta);
    if (reasoning) {
      result.reasoning = reasoning;
    }

    return result;
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  applyProviderExtensions(payload: any, extensions: any): any {
    // OpenRouter specific extensions
    if (extensions.provider) {
      payload.provider = extensions.provider;
      delete extensions.provider;
    }
    
    // Add other OpenRouter-specific fields
    const openRouterFields = ['transforms', 'route', 'models'];
    for (const field of openRouterFields) {
      if (extensions[field] !== undefined) {
        payload[field] = extensions[field];
        delete extensions[field];
      }
    }

    return payload;
  }

  private normalizeUsageStats(raw: any): UsageStats {
    return {
      promptTokens: raw.prompt_tokens ?? raw.promptTokens,
      completionTokens: raw.completion_tokens ?? raw.completionTokens,
      totalTokens: raw.total_tokens ?? raw.totalTokens,
      reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens
    };
  }

  private extractReasoningFromDelta(delta: any): ReasoningData | undefined {
    if (!delta?.reasoning) {
      return undefined;
    }

    const segments = Array.isArray(delta.reasoning) ? delta.reasoning : [delta.reasoning];
    const textParts: string[] = [];
    const metadata: Record<string, any> = {};

    for (const segment of segments) {
      if (!segment) continue;

      if (typeof segment === 'string') {
        textParts.push(segment);
        continue;
      }

      if (typeof segment.text === 'string') {
        textParts.push(segment.text);
      }

      if (Array.isArray(segment.content)) {
        for (const part of segment.content) {
          if (part?.type === 'output_text' && typeof part.text === 'string') {
            textParts.push(part.text);
          }
        }
      }

      if (segment.metadata && typeof segment.metadata === 'object') {
        Object.assign(metadata, segment.metadata);
      }
    }

    if (textParts.length === 0) {
      return undefined;
    }

    return {
      text: textParts.join(''),
      metadata: {
        provider: 'openai',
        ...metadata
      }
    };
  }
}
