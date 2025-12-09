import OpenAI from 'openai';
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
  ParsedStreamChunk,
  ReasoningData
} from '../../core/types.js';

interface ResponsesAPIMessage {
  role?: string;
  content?: Array<{type: string; text?: string}>;
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export default class OpenAIResponsesCompat implements ICompatModule {
  // Track tool call state across stream chunks - keyed by item_id, stores call_id and name
  private toolCallState = new Map<string, { callId: string; name: string; arguments: string }>();
  // Track if we've seen tool calls in this stream
  private seenToolCallsInStream = false;

  /**
   * Get SDK client with API key from headers or environment
   */
  private getSDKClient(headers?: Record<string, string>): OpenAI {
    // Extract from headers.Authorization first
    let apiKey = headers?.Authorization;

    // Strip "Bearer " prefix if present
    if (apiKey?.startsWith('Bearer ')) {
      apiKey = apiKey.substring(7);
    }

    // Fallback to environment variables
    if (!apiKey) {
      apiKey = process.env.OPENAI_API_KEY;
    }

    if (!apiKey) {
      throw new Error('OpenAI API key required in headers.Authorization or OPENAI_API_KEY environment variable');
    }

    return new OpenAI({ apiKey });
  }

  /**
   * SDK-based call method - uses OpenAI SDK's responses.create()
   */
  async callSDK(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    logger?: any,
    headers?: Record<string, string>
  ): Promise<LLMResponse> {
    const client = this.getSDKClient(headers);
    const params = this.buildSDKParams(model, settings, messages, tools, toolChoice);

    if (logger) {
      logger.info('OpenAI Responses SDK create params', { model, paramsKeys: Object.keys(params) });
    }

    try {
      const response = await client.responses.create(params);
      return this.parseSDKResponse(response, model);
    } catch (error: any) {
      if (logger) {
        logger.error('OpenAI Responses SDK call failed', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * SDK-based streaming method - uses OpenAI SDK streaming
   */
  async *streamSDK(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    logger?: any,
    headers?: Record<string, string>
  ): AsyncGenerator<any> {
    const client = this.getSDKClient(headers);
    const params = this.buildSDKParams(model, settings, messages, tools, toolChoice);

    // Enable streaming
    params.stream = true;

    // Reset streaming state for this new stream
    this.toolCallState.clear();
    this.seenToolCallsInStream = false;

    if (logger) {
      logger.info('OpenAI Responses SDK stream params', { model, paramsKeys: Object.keys(params) });
    }

    try {
      const stream = await client.responses.create(params) as any;

      // Yield raw SDK events - they will be parsed by parseStreamChunk()
      for await (const event of stream) {
        yield event;
      }
    } catch (error: any) {
      if (logger) {
        logger.error('OpenAI Responses SDK streaming failed', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * Build SDK-compatible parameters object for Responses API
   */
  private buildSDKParams(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    const input = this.serializeMessages(messages);
    const settingsParams = this.serializeSettings(settings);
    const sdkTools = this.serializeToolsForSDK(tools);
    const toolChoiceParam = this.serializeToolChoiceForSDK(toolChoice);

    const params: any = {
      model,
      input
    };

    // Add settings
    Object.assign(params, settingsParams);

    // Add tools if present
    if (sdkTools && sdkTools.length > 0) {
      params.tools = sdkTools;
    }

    // Add tool choice if present
    if (toolChoiceParam !== undefined) {
      params.tool_choice = toolChoiceParam;
    }

    return params;
  }

  /**
   * Convert unified messages to Responses API input format
   */
  private serializeMessages(messages: Message[]): ResponsesAPIMessage[] | string {
    if (messages.length === 0) {
      return [];
    }

    // Simple case: single user message with just text can be a string
    if (messages.length === 1 &&
        messages[0].role === Role.USER &&
        messages[0].content.length === 1 &&
        messages[0].content[0].type === 'text' &&
        !messages[0].toolCalls) {
      return (messages[0].content[0] as TextContent).text;
    }

    // Complex case: build structured input array
    const input: ResponsesAPIMessage[] = [];
    let outputIdCounter = 1;

    for (const message of messages) {
      if (message.role === Role.SYSTEM) {
        // System messages: add as first user message with special handling
        // Note: Responses API may not have explicit system role, so we prepend to first user message
        // or create a user message with system content
        const textParts = message.content
          .filter(c => c.type === 'text')
          .map(c => (c as TextContent).text)
          .join('\n');

        if (textParts) {
          // Add as user message at the start
          input.push({
            role: 'user',
            content: [{ type: 'input_text', text: `System: ${textParts}` }]
          });
        }
        continue;
      }

      if (message.role === Role.USER) {
        const contentParts = this.serializeContent(message.content, 'input_text');
        if (contentParts.length > 0 || message.content.length === 0) {
          input.push({
            role: 'user',
            content: contentParts
          });
        }
        continue;
      }

      if (message.role === Role.ASSISTANT) {
        // Assistant message may have text content and/or tool calls
        const textContent = message.content
          .filter(c => c.type === 'text')
          .map(c => ({ type: 'output_text', text: (c as TextContent).text }));

        if (textContent.length > 0) {
          input.push({
            role: 'assistant',
            content: textContent
          });
        }

        // Add tool calls as separate function_call items
        if (message.toolCalls && message.toolCalls.length > 0) {
          for (const toolCall of message.toolCalls) {
            input.push({
              type: 'function_call',
              id: `fc_${outputIdCounter++}`, // API requires IDs to start with 'fc'
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments)
            });
          }
        }
        continue;
      }

      if (message.role === Role.TOOL) {
        // Tool results: convert to function_call_output
        // Prefer tool_result type content over text content
        const toolResultParts = message.content.filter(c => c.type === 'tool_result');
        let output = '';

        if (toolResultParts.length > 0) {
          // Extract from tool_result items
          const results: string[] = [];
          for (const part of toolResultParts) {
            const toolResult = part as any;
            if (Array.isArray(toolResult.result)) {
              // Result is an array of content parts
              for (const item of toolResult.result) {
                if (item.type === 'text') {
                  results.push(item.text);
                }
              }
            } else if (typeof toolResult.result === 'string') {
              results.push(toolResult.result);
            } else {
              // Fallback: stringify the result
              results.push(JSON.stringify(toolResult.result));
            }
          }
          output = results.join('\n');
        } else {
          // Fallback to text parts
          output = message.content
            .filter(c => c.type === 'text')
            .map(c => (c as TextContent).text)
            .join('\n');
        }

        input.push({
          type: 'function_call_output',
          id: `fc_${outputIdCounter++}`, // API requires IDs to start with 'fc'
          call_id: message.toolCallId || 'unknown',
          output: output || ''
        });
        continue;
      }
    }

    return input;
  }

  /**
   * Convert content parts to Responses API format
   */
  private serializeContent(parts: ContentPart[], textType: string): Array<{type: string; text?: string; image_url?: any; file?: any}> {
    return parts.map(part => {
      if (part.type === 'text') {
        return { type: textType, text: part.text };
      }
      if (part.type === 'image') {
        // Image content format for Responses API (needs verification)
        return {
          type: 'image_url',
          image_url: { url: part.imageUrl }
        };
      }
      if (part.type === 'document') {
        // OpenAI Responses API file format (input_file content part)
        // Accepts either file_data (base64/data URL), file_url, or file_id
        const filename = part.filename || 'document';
        if (part.source.type === 'base64') {
          const dataUrl = `data:${part.mimeType};base64,${part.source.data}`;
          return {
            type: 'input_file',
            filename,
            file_data: dataUrl
          };
        }
        if (part.source.type === 'url') {
          return {
            type: 'input_file',
            filename,
            file_data: part.source.url
          };
        }
        if (part.source.type === 'file_id') {
          return {
            type: 'input_file',
            file_id: part.source.fileId
          };
        }
      }
      return null;
    }).filter(Boolean) as Array<{type: string; text?: string; image_url?: any; file?: any}>;
  }

  /**
   * Map unified settings to Responses API parameters
   */
  private serializeSettings(settings: LLMCallSettings): any {
    const result: any = {};

    // Map maxTokens to max_output_tokens (key difference from Chat Completions)
    if (settings.maxTokens !== undefined) {
      result.max_output_tokens = settings.maxTokens;
    }

    // Include temperature if set
    if (settings.temperature !== undefined) {
      result.temperature = settings.temperature;
    }

    // Include topP if set
    if (settings.topP !== undefined) {
      result.top_p = settings.topP;
    }

    // Add reasoning support for OpenAI Responses API
    // OpenAI Responses API uses { reasoning: { effort: 'high' | 'medium' | 'low' | 'minimal' } }
    // Note: Unlike Chat Completions, Responses API only supports effort, not max_tokens/budget
    if (settings.reasoning) {
      const validEfforts = ['high', 'medium', 'low', 'minimal'];
      if (settings.reasoning.effort && validEfforts.includes(settings.reasoning.effort)) {
        result.reasoning = {
          effort: settings.reasoning.effort
        };
      }
    }

    return result;
  }

  /**
   * Convert unified tools to Responses API format
   * Note: Responses API uses a hybrid format - has type field but other fields aren't nested
   */
  private serializeToolsForSDK(tools: UnifiedTool[]): any[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema || {
        type: 'object',
        properties: {}
      }
    }));
  }

  /**
   * Convert unified tool choice to Responses API format
   * Note: Responses API uses simpler string-based tool choice format
   */
  private serializeToolChoiceForSDK(choice?: ToolChoice): any {
    if (!choice) return undefined;

    if (typeof choice === 'string') {
      // 'auto' or 'none'
      if (choice === 'none') {
        return undefined; // Omit for none
      }
      return choice; // 'auto'
    }

    if (choice.type === 'single') {
      // Force specific tool - use just the tool name
      return choice.name;
    }

    if (choice.type === 'required') {
      // Require any tool
      return 'required';
    }

    return undefined;
  }

  /**
   * Parse Responses API response to unified format
   */
  private parseSDKResponse(raw: any, model: string): LLMResponse {
    const output = raw.output || [];

    // Extract text content from output items
    // Response format has "message" wrappers with nested content arrays
    const textContent: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];

    for (const item of output) {
      // Handle message type with nested content
      if (item.type === 'message' && item.content) {
        for (const contentItem of item.content) {
          if (contentItem.type === 'output_text') {
            textContent.push({ type: 'text', text: contentItem.text || '' } as TextContent);
          }
        }
      }

      // Handle direct output_text items (for backwards compatibility)
      else if (item.type === 'output_text') {
        textContent.push({ type: 'text', text: item.text || '' } as TextContent);
      }

      // Handle function_call items
      else if (item.type === 'function_call') {
        let parsedArgs = {};
        if (item.arguments) {
          try {
            parsedArgs = JSON.parse(item.arguments);
          } catch (e) {
            // Handle malformed JSON gracefully
            parsedArgs = {};
          }
        }
        toolCalls.push({
          id: item.call_id || `call_${toolCalls.length}`,
          name: item.name || '',
          arguments: parsedArgs
        });
      }
    }

    // Extract usage stats
    const usage = this.parseUsage(raw.usage);

    // Determine finish reason: if there are tool calls, use 'tool_calls' to signal coordinator
    let finishReason = raw.status;
    if (toolCalls.length > 0 && textContent.length === 0) {
      finishReason = 'tool_calls';
    }

    return {
      provider: 'openai',
      model: model,
      role: Role.ASSISTANT,
      content: textContent.length > 0 ? textContent : [{ type: 'text', text: '' } as TextContent],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
      raw
    };
  }

  /**
   * Parse usage statistics
   */
  private parseUsage(usage: any): UsageStats | undefined {
    if (!usage) return undefined;

    return {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.total_tokens
    };
  }

  /**
   * Parse streaming events from Responses API
   */
  parseStreamChunk(event: any): ParsedStreamChunk {
    const result: ParsedStreamChunk = {};

    const eventType = event.type;

    // Handle text deltas
    if (eventType === 'response.output_text.delta') {
      result.text = event.delta;
    }

    // Handle function call events - note: actual event types differ from initial documentation
    // Start event: response.output_item.added with type function_call
    if (eventType === 'response.output_item.added' && event.item?.type === 'function_call') {
      const itemId = event.item.id;
      const callId = event.item.call_id;
      const name = event.item.name;

      // Track by item_id since that's what delta events use
      this.toolCallState.set(itemId, { callId, name, arguments: '' });
      // Mark that we've seen tool calls in this stream
      this.seenToolCallsInStream = true;

      result.toolEvents = [{
        type: ToolCallEventType.TOOL_CALL_START,
        callId,
        name
      }];
    }

    // Delta event: response.function_call_arguments.delta (uses item_id not call_id)
    if (eventType === 'response.function_call_arguments.delta') {
      const itemId = event.item_id;
      const delta = event.delta;

      const state = this.toolCallState.get(itemId);
      if (state) {
        state.arguments += delta;

        result.toolEvents = [{
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: state.callId,
          argumentsDelta: delta
        }];
      }
    }

    // Done event: response.function_call_arguments.done (uses item_id not call_id)
    if (eventType === 'response.function_call_arguments.done') {
      const itemId = event.item_id;
      const args = event.arguments;

      // Get call_id and name from state
      const state = this.toolCallState.get(itemId);
      if (state) {
        result.toolEvents = [{
          type: ToolCallEventType.TOOL_CALL_END,
          callId: state.callId,
          name: state.name,
          arguments: args
        }];

        // Clean up state for this call
        this.toolCallState.delete(itemId);
      }
    }

    // Handle response completion: response.completed (not response.done)
    if (eventType === 'response.completed') {
      // Signal coordinator to execute tools if we saw tool calls
      if (this.seenToolCallsInStream) {
        result.finishedWithToolCalls = true;
        // Reset for next stream
        this.seenToolCallsInStream = false;
      }

      // Clear all state
      this.toolCallState.clear();

      // Extract usage if present
      if (event.response?.usage) {
        result.usage = this.parseUsage(event.response.usage);
      }
    }

    return result;
  }

  /**
   * Get streaming flags (empty for SDK-based)
   */
  getStreamingFlags(): any {
    return {};
  }

  /**
   * Serialize tools (helper for interface compatibility)
   */
  serializeTools(tools: UnifiedTool[]): any {
    const sdkTools = this.serializeToolsForSDK(tools);
    return sdkTools ? { tools: sdkTools } : {};
  }

  /**
   * Serialize tool choice (helper for interface compatibility)
   */
  serializeToolChoice(choice?: ToolChoice): any {
    const toolChoice = this.serializeToolChoiceForSDK(choice);
    return toolChoice !== undefined ? { tool_choice: toolChoice } : {};
  }

  /**
   * HTTP methods throw errors (this is SDK-only compat)
   */
  buildPayload(): any {
    throw new Error('OpenAI Responses compat is SDK-only. Use callSDK() instead of HTTP methods.');
  }

  parseResponse(): LLMResponse {
    throw new Error('OpenAI Responses compat is SDK-only. Use parseSDKResponse() instead of HTTP methods.');
  }

  applyProviderExtensions(payload: any, _extensions: any): any {
    return payload;
  }
}
