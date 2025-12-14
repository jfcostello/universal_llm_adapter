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
} from '../../../../core/types.js';


export default class AnthropicCompat implements ICompatModule {
  // Track tool call state across stream chunks
  private toolCallState = new Map<string, { name?: string; input: string }>();
  private contentBlockIndexToCallId = new Map<number, string>();

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
          .filter(part => part.type === 'text' && typeof (part as TextContent).text === 'string')
          .map(part => (part as TextContent).text)
          .join('')
      : undefined;

    // Check if thinking should be enabled
    // IMPORTANT: Anthropic requires thinking blocks on ALL assistant messages when thinking is enabled
    // Only enable thinking if all assistant messages have reasoning data
    const reasoning = settings.reasoning;
    const thinkingRequested = reasoning?.enabled ?? false;
    const allAssistantMessagesHaveReasoning = nonSystemMessages
      .filter(m => m.role === Role.ASSISTANT)
      .every(m => m.reasoning && !m.reasoning.redacted);

    // Only enable thinking if requested AND all assistant messages have reasoning
    const thinkingEnabled = thinkingRequested && allAssistantMessagesHaveReasoning;

    // Convert messages to Anthropic format (handling tool results as content blocks)
    const anthropicMessages = this.serializeMessages(nonSystemMessages);

    const payload: any = {
      model,
      max_tokens: settings.maxTokens ?? 8192, // Required by Anthropic, default to 8192
      messages: anthropicMessages,
      ...this.serializeSettings(settings),
      ...this.serializeTools(tools),
      ...this.serializeToolChoice(toolChoice)
    };

    // Add system prompt if present
    if (systemPrompt !== undefined) {
      payload.system = systemPrompt;
    }

    // Transform reasoning to Anthropic's thinking format
    // (reasoning already extracted above for thinking check)
    if (thinkingEnabled && reasoning) {
      const budget = reasoning.budget || settings.reasoningBudget || 51200;
      payload.thinking = {
        type: 'enabled',
        budget_tokens: budget
      };
    }

    return payload;
  }

  private serializeMessages(messages: Message[]): any[] {
    const anthropicMessages: any[] = [];
    let pendingToolResults: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      if (message.role === Role.TOOL) {
        // Collect tool results to be added to the next user message
        const toolResultContent = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: this.serializeToolResult(message.content)
        };
        pendingToolResults.push(toolResultContent);
        continue;
      }

      // If we have pending tool results and this is an assistant message,
      // we must flush the tool results first (Anthropic requires tool_result immediately after tool_use)
      if (pendingToolResults.length > 0 && message.role === Role.ASSISTANT) {
        anthropicMessages.push({
          role: Role.USER,
          content: pendingToolResults
        });
        pendingToolResults = [];
      }

      // Build message content
      const content: any[] = [];

      // If this is an assistant message with reasoning, inject thinking block FIRST
      // This is CRITICAL: Anthropic requires thinking blocks at the start when thinking is enabled
      // IMPORTANT: Always include full reasoning with signature - ignore redacted flag
      // Anthropic's cryptographic signatures require unaltered thinking blocks
      if (message.role === Role.ASSISTANT && message.reasoning) {
        const thinkingBlock: any = {
          type: 'thinking',
          thinking: message.reasoning.text
        };

        // Always include signature if present - required by Anthropic
        if (message.reasoning.metadata?.signature) {
          thinkingBlock.signature = message.reasoning.metadata.signature;
        }

        content.push(thinkingBlock);
      }

      // If this is a user message and we have pending tool results, add them first
      if (message.role === Role.USER && pendingToolResults.length > 0) {
        content.push(...pendingToolResults);
        pendingToolResults = [];
      }

      // Add regular content
      content.push(...this.serializeContent(message.content));

      // If this is an assistant message with tool calls, add tool_use blocks
      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const toolCall of message.toolCalls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.arguments
          });
        }
      }

      // Build the message
      const anthropicMessage: any = {
        role: message.role,
        content
      };

      anthropicMessages.push(anthropicMessage);
    }

    // If there are still pending tool results at the end, create a user message for them
    if (pendingToolResults.length > 0) {
      anthropicMessages.push({
        role: Role.USER,
        content: pendingToolResults
      });
    }

    return anthropicMessages;
  }

  private serializeToolResult(contentParts: ContentPart[]): string {
    // Convert content parts to a string representation for tool results
    const textParts = contentParts
      .filter(c => c.type === 'text')
      .map(c => (c as TextContent).text);

    if (textParts.length > 0) {
      return textParts.join('\n');
    }

    // For non-text content (like tool_result), serialize as JSON
    return JSON.stringify(contentParts);
  }

  private serializeContent(parts: ContentPart[]): any[] {
    return parts
      .map(part => {
        if (part.type === 'text') {
          // Skip empty text blocks - Anthropic requires non-empty text
          if (!part.text || part.text.trim() === '') {
            return null;
          }
          return { type: 'text', text: part.text };
        }
        if (part.type === 'image') {
          // Anthropic image format
          return {
            type: 'image',
            source: {
              type: 'url',
              url: part.imageUrl
            }
          };
        }
        if (part.type === 'document') {
          // Anthropic document format
          const docBlock: any = {
            type: 'document',
            source: {}
          };

          // Handle different source types
          if (part.source.type === 'base64') {
            docBlock.source = {
              type: 'base64',
              media_type: part.mimeType,
              data: part.source.data  // Raw base64, no prefix
            };
          } else if (part.source.type === 'url') {
            docBlock.source = {
              type: 'url',
              url: part.source.url
            };
          } else if (part.source.type === 'file_id') {
            docBlock.source = {
              type: 'file',
              file_id: part.source.fileId
            };
          }

          // Add prompt caching if specified
          if (part.providerOptions?.anthropic?.cacheControl) {
            docBlock.cache_control = part.providerOptions.anthropic.cacheControl;
          }

          return docBlock;
        }
        // Skip tool_result content parts here - they're handled separately
        return null;
      })
      .filter(Boolean);
  }

  private serializeSettings(settings: LLMCallSettings): any {
    const result: any = {};

    if (settings.temperature !== undefined) {
      result.temperature = settings.temperature;
    }
    if (settings.topP !== undefined) {
      result.top_p = settings.topP;
    }
    if (settings.stop) {
      result.stop_sequences = settings.stop;
    }

    return result;
  }

  serializeTools(tools: UnifiedTool[]): any {
    if (!tools || tools.length === 0) {
      return {};
    }

    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parametersJsonSchema || {
          type: 'object',
          properties: {}
        }
      }))
    };
  }

  serializeToolChoice(choice?: ToolChoice): any {
    if (!choice) return {};

    if (typeof choice === 'string') {
      // Anthropic uses 'auto' and 'any' (not 'none')
      if (choice === 'auto') {
        return { tool_choice: { type: 'auto' } };
      }
      if (choice === 'none') {
        // Anthropic doesn't have 'none', just omit tool_choice
        return {};
      }
      return {};
    }

    if (choice.type === 'single') {
      return {
        tool_choice: {
          type: 'tool',
          name: choice.name
        }
      };
    }

    if (choice.type === 'required') {
      // Anthropic uses 'any' to require any tool
      return { tool_choice: { type: 'any' } };
    }

    return {};
  }

  parseResponse(raw: any, model: string): LLMResponse {
    const content: ContentPart[] = this.parseContent(raw.content);
    const toolCalls = this.parseToolCalls(raw.content);
    const usage = this.parseUsage(raw.usage);
    const reasoning = this.parseReasoning(raw.content);

    return {
      provider: 'anthropic',
      model: model,
      role: Role.ASSISTANT,
      content: content.length > 0 ? content : [{ type: 'text', text: '' } as TextContent],
      toolCalls,
      finishReason: this.mapStopReason(raw.stop_reason),
      usage,
      reasoning,
      raw
    };
  }

  private parseContent(contentBlocks: any[]): ContentPart[] {
    if (!contentBlocks || !Array.isArray(contentBlocks)) {
      return [];
    }

    return contentBlocks
      .filter(block => block.type === 'text')
      .map(block => ({ type: 'text', text: block.text || '' } as TextContent));
  }

  private parseToolCalls(contentBlocks: any[]): ToolCall[] | undefined {
    if (!contentBlocks || !Array.isArray(contentBlocks)) {
      return undefined;
    }

    const toolUseBlocks = contentBlocks.filter(block => block.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      return undefined;
    }

    return toolUseBlocks.map((block, index) => ({
      id: block.id || `call_${index}`,
      name: block.name || '',
      arguments: block.input || {}
    }));
  }

  private parseUsage(usage: any): UsageStats | undefined {
    if (!usage) return undefined;

    return {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
    };
  }

  private parseReasoning(contentBlocks: any[]): ReasoningData | undefined {
    if (!contentBlocks || !Array.isArray(contentBlocks)) {
      return undefined;
    }

    // Find thinking blocks in content
    const thinkingBlock = contentBlocks.find(block => block.type === 'thinking');

    if (!thinkingBlock || !thinkingBlock.thinking) {
      return undefined;
    }

    // Preserve Anthropic-specific metadata (signature)
    const metadata: Record<string, any> = {};
    if (thinkingBlock.signature) {
      metadata.signature = thinkingBlock.signature;
    }

    return {
      text: thinkingBlock.thinking,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined
    };
  }

  private mapStopReason(stopReason: string | undefined): string | undefined {
    if (!stopReason) return undefined;

    const mapping: Record<string, string> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls',
      'stop_sequence': 'stop'
    };

    return mapping[stopReason] || stopReason;
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    const result: ParsedStreamChunk = {};

    // Handle different Anthropic streaming event types
    if (chunk.type === 'message_start') {
      // New stream starting - clear any stale state from previous streams
      this.toolCallState.clear();
      this.contentBlockIndexToCallId.clear();
    } else if (chunk.type === 'content_block_start') {
      const block = chunk.content_block;
      const blockIndex = chunk.index;

      if (block.type === 'tool_use') {
        const callId = block.id;
        this.toolCallState.set(callId, { name: block.name, input: '' });
        this.contentBlockIndexToCallId.set(blockIndex, callId);

        result.toolEvents = [{
          type: ToolCallEventType.TOOL_CALL_START,
          callId,
          name: block.name
        }];
      }
    } else if (chunk.type === 'content_block_delta') {
      const delta = chunk.delta;

      if (delta.type === 'text_delta') {
        result.text = delta.text;
      } else if (delta.type === 'input_json_delta') {
        // Tool input delta
        const blockIndex = chunk.index;
        const callId = this.contentBlockIndexToCallId.get(blockIndex);

        if (callId) {
          const state = this.toolCallState.get(callId);
          if (state) {
            state.input += delta.partial_json;

            result.toolEvents = [{
              type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
              callId,
              argumentsDelta: delta.partial_json
            }];
          }
        }
      }
    } else if (chunk.type === 'content_block_stop') {
      // Content block finished
      const blockIndex = chunk.index;
      const callId = this.contentBlockIndexToCallId.get(blockIndex);

      if (callId) {
        const state = this.toolCallState.get(callId);
        if (state) {
          result.toolEvents = [{
            type: ToolCallEventType.TOOL_CALL_END,
            callId,
            name: state.name,
            arguments: state.input
          }];
        }
      }
    } else if (chunk.type === 'message_delta') {
      // Check if stream finished with tool use
      if (chunk.delta?.stop_reason === 'tool_use') {
        result.finishedWithToolCalls = true;
      }
    } else if (chunk.type === 'message_stop') {
      // Stream finished, clear state
      this.toolCallState.clear();
      this.contentBlockIndexToCallId.clear();
    }

    const usage = this.extractUsageStats(chunk);
    if (usage) {
      result.usage = usage;
    }

    const reasoning = this.extractReasoning(chunk);
    if (reasoning) {
      result.reasoning = reasoning;
    }

    return result;
  }

  private extractUsageStats(chunk: any): UsageStats | undefined {
    const usage = chunk.usage ?? chunk.delta?.usage;
    if (!usage) {
      return undefined;
    }

    const promptTokens = usage.input_tokens ?? usage.prompt_tokens;
    const completionTokens = usage.output_tokens ?? usage.completion_tokens;

    return {
      promptTokens,
      completionTokens,
      totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      reasoningTokens: usage.reasoning_tokens
    };
  }

  private extractReasoning(chunk: any): ReasoningData | undefined {
    const candidate = chunk.delta?.thinking ?? chunk.delta?.analysis ?? chunk.thinking;
    if (!candidate) {
      return undefined;
    }

    if (typeof candidate === 'string') {
      return {
        text: candidate,
        metadata: { provider: 'anthropic' }
      };
    }

    if (candidate.text) {
      return {
        text: candidate.text,
        metadata: {
          provider: 'anthropic',
          ...candidate.metadata
        }
      };
    }

    if (Array.isArray(candidate.content)) {
      const textParts = candidate.content
        .map((part: any) => part?.text)
        .filter((part: any): part is string => typeof part === 'string');
      if (textParts.length > 0) {
        return {
          text: textParts.join(''),
          metadata: {
            provider: 'anthropic',
            ...candidate.metadata
          }
        };
      }
    }

    return undefined;
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  applyProviderExtensions(payload: any, _extensions: any): any {
    return payload;
  }
}
