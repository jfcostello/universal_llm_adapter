import { GoogleGenAI } from '@google/genai';
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
import { sanitizeToolName } from '../../utils/tools/tool-names.js';

type GooglePart = {
  text?: string;
  fileData?: { fileUri: string; mimeType?: string };
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: any };
  functionResponse?: { name?: string; response?: any };
};

type GoogleContent = {
  role: 'user' | 'model';
  parts: GooglePart[];
};

export default class GoogleCompat implements ICompatModule {
  constructor() {
    // SDK client created per-call using headers
  }

  /**
   * Get SDK client with API key from headers or environment
   */
  private getSDKClient(headers?: Record<string, string>): GoogleGenAI {
    // Extract from headers.Authorization first
    let apiKey = headers?.Authorization;

    // Fallback to environment variables
    if (!apiKey) {
      apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    }

    if (!apiKey) {
      throw new Error('Google API key required in headers.Authorization or GOOGLE_API_KEY environment variable');
    }

    return new GoogleGenAI({ apiKey });
  }

  /**
   * SDK-based call method - uses @google/genai SDK instead of HTTP
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
    const ai = this.getSDKClient(headers);
    const params = this.buildSDKParams(model, settings, messages, tools, toolChoice);

    if (logger) {
      logger.info('Google SDK generateContent params', { model, paramsKeys: Object.keys(params) });
    }

    try {
      const response = await ai.models.generateContent(params);
      return this.parseSDKResponse(response, model);
    } catch (error: any) {
      if (logger) {
        logger.error('Google SDK call failed', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * SDK-based streaming method - uses @google/genai SDK streaming
   * Yields raw SDK chunks to be parsed by parseStreamChunk()
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
    const ai = this.getSDKClient(headers);
    const params = this.buildSDKParams(model, settings, messages, tools, toolChoice);

    // Reset streaming state for this new stream
    this.seenToolCallsInStream = false;

    if (logger) {
      logger.info('Google SDK generateContentStream params', { model, paramsKeys: Object.keys(params) });
    }

    try {
      const response = await ai.models.generateContentStream(params);

      // Yield raw SDK chunks - they will be parsed by parseStreamChunk()
      for await (const chunk of response) {
        yield chunk;
      }
    } catch (error: any) {
      if (logger) {
        logger.error('Google SDK streaming failed', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * Build SDK-compatible parameters object
   */
  private buildSDKParams(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    const { contents, systemInstruction } = this.serializeMessages(messages);
    const generationConfig = this.serializeSettings(settings);
    const sdkTools = this.serializeToolsForSDK(tools);
    const toolConfig = this.serializeToolChoiceForSDK(toolChoice, tools);

    const params: any = {
      model,
      contents
    };

    // Config object bundles generation settings, tools, systemInstruction, and tool config
    const config: any = {};

    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    if (Object.keys(generationConfig).length > 0) {
      Object.assign(config, generationConfig);
    }

    if (sdkTools) {
      config.tools = sdkTools;
    }

    if (toolConfig) {
      config.toolConfig = toolConfig;
    }

    if (Object.keys(config).length > 0) {
      params.config = config;
    }

    return params;
  }

  /**
   * Convert unified messages to Google SDK format
   */
  private serializeMessages(messages: Message[]): { contents: GoogleContent[]; systemInstruction?: any } {
    let systemText: string | undefined;
    const contents: GoogleContent[] = [];

    for (const m of messages) {
      if (m.role === Role.SYSTEM) {
        const text = (m.content || [])
          .filter(p => p.type === 'text')
          .map(p => (p as TextContent).text ?? '')
          .join('');
        if (text && text.length) {
          systemText = (systemText || '') + text;
        }
        continue;
      }

      if (m.role === Role.TOOL) {
        const [name, response] = this.extractToolResponse(m);
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response } }]
        });
        continue;
      }

      const parts: GooglePart[] = [];

      // Text, images, and documents
      for (const part of m.content || []) {
        if (part.type === 'text') {
          parts.push({ text: (part as TextContent).text ?? '' });
        } else if (part.type === 'image') {
          const imgPart = part as any;
          parts.push({
            fileData: {
              fileUri: imgPart.imageUrl,
              mimeType: imgPart.mimeType
            }
          });
        } else if (part.type === 'document') {
          const docPart = part as any;
          if (docPart.source.type === 'base64') {
            // Google inline data format
            parts.push({
              inlineData: {
                mimeType: docPart.mimeType,
                data: docPart.source.data  // Raw base64, no prefix
              }
            });
          } else if (docPart.source.type === 'url' || docPart.source.type === 'file_id') {
            // Google Files API format
            parts.push({
              fileData: {
                fileUri: docPart.source.type === 'url' ? docPart.source.url : docPart.source.fileId,
                mimeType: docPart.mimeType
              }
            });
          }
        }
      }

      // Assistant tool calls -> functionCall parts
      if (m.role === Role.ASSISTANT && m.toolCalls && m.toolCalls.length) {
        for (const call of m.toolCalls) {
          const part: any = {
            functionCall: {
              name: call.name,
              args: call.arguments ?? {}
            }
          };
          // Preserve thoughtSignature if present in metadata
          // This is required for Gemini models with reasoning enabled
          if (call.metadata?.thoughtSignature) {
            part.thoughtSignature = call.metadata.thoughtSignature;
          }
          parts.push(part);
        }
      }

      if (m.role === Role.USER) {
        contents.push({ role: 'user', parts });
      } else if (m.role === Role.ASSISTANT) {
        contents.push({ role: 'model', parts });
      }
    }

    const systemInstruction = systemText
      ? [{ text: systemText }]
      : undefined;

    return { contents, systemInstruction };
  }

  /**
   * Extract tool response from tool message
   */
  private extractToolResponse(message: Message): [string | undefined, any] {
    const contentParts = message.content || [];
    const toolPart = contentParts.find(p => p.type === 'tool_result') as any;
    if (toolPart && toolPart.toolName) {
      // CRITICAL: Must sanitize to match functionDeclaration name
      const name = sanitizeToolName(toolPart.toolName);

      // Collect ALL text parts (formatted result + countdown text + truncation notices)
      // This is critical for the model to see tool call budget information
      const textParts = contentParts
        .filter(p => p.type === 'text')
        .map(p => (p as TextContent).text ?? '');

      // Google requires functionResponse.response to be a Struct (JSON object), not a string
      // Wrap combined text in an object structure to make it a valid Struct
      let response: any;
      if (textParts.length > 0) {
        // Combine all text parts (result + countdown + truncation)
        const combinedText = textParts.join('\n');
        // Wrap in object with "output" key - this makes it a valid Struct while preserving text
        response = { output: combinedText };
      } else {
        // No text parts - use raw result object
        response = toolPart.result !== undefined ? toolPart.result : {};
      }

      return [name, response];
    }

    const text = (message.content || [])
      .filter(p => p.type === 'text')
      .map(p => (p as TextContent).text ?? '')
      .join('');
    return [undefined, text];
  }

  /**
   * Convert settings to Google generationConfig
   */
  private serializeSettings(settings: LLMCallSettings): any {
    const config: any = {};

    if (settings.temperature !== undefined) config.temperature = settings.temperature;
    if (settings.topP !== undefined) config.topP = settings.topP;
    if (settings.maxTokens !== undefined) config.maxOutputTokens = settings.maxTokens;
    if (settings.stop && settings.stop.length) config.stopSequences = settings.stop;

    // Reasoning/thinking budget
    const budget = settings.reasoning?.budget ?? settings.reasoningBudget;
    if (budget !== undefined) {
      config.thinkingConfig = { thinkingBudget: budget };
    }

    return config;
  }

  /**
   * Convert tools to Google SDK functionDeclarations format
   */
  private serializeToolsForSDK(tools: UnifiedTool[]): any {
    if (!tools || tools.length === 0) return undefined;

    const functionDeclarations = tools.map(t => ({
      name: sanitizeToolName(t.name),
      description: t.description || '',
      parameters: this.convertSchemaToGoogleFormat(t.parametersJsonSchema || {})
    }));

    return [{ functionDeclarations }];
  }

  /**
   * Convert JSON Schema to Google parameters format
   */
  private convertSchemaToGoogleFormat(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return { type: 'OBJECT', properties: {} };
    }

    const out: any = {};

    // Map type with Google's enum format
    if (schema.type) {
      const typeMap: any = {
        'string': 'STRING',
        'number': 'NUMBER',
        'integer': 'INTEGER',
        'boolean': 'BOOLEAN',
        'array': 'ARRAY',
        'object': 'OBJECT'
      };
      out.type = typeMap[schema.type] || schema.type.toUpperCase();
    }

    if (schema.description) out.description = schema.description;

    if (schema.properties && typeof schema.properties === 'object') {
      out.properties = {};
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        out.properties[propName] = this.convertSchemaToGoogleFormat(propSchema);
      }
    }

    if (Array.isArray(schema.required)) {
      out.required = schema.required.slice();
    }

    if (schema.items) {
      out.items = this.convertSchemaToGoogleFormat(schema.items);
    }

    if (Array.isArray(schema.enum)) {
      out.enum = schema.enum.slice();
    }

    if (typeof schema.minimum === 'number') out.minimum = schema.minimum;
    if (typeof schema.maximum === 'number') out.maximum = schema.maximum;
    if (typeof schema.format === 'string') out.format = schema.format;

    // Defaults
    if (out.type === 'OBJECT' && !out.properties) {
      out.properties = {};
    }

    if (!out.type && (out.properties || out.required)) {
      out.type = 'OBJECT';
    }

    return Object.keys(out).length ? out : { type: 'OBJECT', properties: {} };
  }

  /**
   * Convert tool choice to Google functionCallingConfig
   */
  private serializeToolChoiceForSDK(choice?: ToolChoice, tools?: UnifiedTool[]): any {
    if (!choice) {
      // Default behavior: AUTO mode (model decides whether to call tools or respond with text)
      if (tools && tools.length > 0) {
        return {
          functionCallingConfig: {
            mode: 'AUTO'
          }
        };
      }
      return undefined;
    }

    if (typeof choice === 'string') {
      if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
      if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
      return undefined;
    }

    if (choice.type === 'single') {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [sanitizeToolName(choice.name)]
        }
      };
    }

    if (choice.type === 'required') {
      const cfg: any = { mode: 'ANY' };
      if (choice.allowed && choice.allowed.length) {
        cfg.allowedFunctionNames = choice.allowed.map(sanitizeToolName);
      }
      return { functionCallingConfig: cfg };
    }

    return undefined;
  }

  /**
   * Parse SDK response to unified format
   */
  private parseSDKResponse(raw: any, model: string): LLMResponse {
    const candidate = (raw.candidates && raw.candidates[0]) || {};
    const parts: any[] = candidate.content?.parts || [];

    const content: ContentPart[] = parts
      .filter(p => typeof p?.text === 'string' && p.thought !== true)
      .map(p => ({ type: 'text', text: p.text } as TextContent));

    const toolCalls = this.extractToolCalls(parts);
    const usage = this.extractUsage(raw.usageMetadata);
    const reasoning = this.extractReasoning(parts);

    return {
      provider: 'Google',
      model,
      role: Role.ASSISTANT,
      content: content.length ? content : [{ type: 'text', text: '' } as TextContent],
      toolCalls,
      finishReason: candidate.finishReason,
      usage,
      reasoning,
      raw
    };
  }

  // Track if we've seen tool calls in this stream (for multi-chunk streaming)
  private seenToolCallsInStream = false;

  /**
   * Parse streaming SDK chunk
   */
  private parseSDKChunk(chunk: any): ParsedStreamChunk {
    const result: ParsedStreamChunk = {};
    const candidate = (chunk.candidates && chunk.candidates[0]) || {};
    const parts: any[] = candidate.content?.parts || [];

    // Extract text (excluding thought parts)
    const text = parts
      .filter(p => typeof p?.text === 'string' && p.thought !== true)
      .map(p => p.text)
      .join('');
    if (text) result.text = text;

    // Extract reasoning/thinking
    const reasoning = this.extractReasoning(parts);
    if (reasoning) result.reasoning = reasoning;

    // Extract function calls
    const fc = parts.find(p => p.functionCall);
    if (fc && fc.functionCall) {
      const name = fc.functionCall.name || '';
      const argsObj = fc.functionCall.args || {};
      const argsStr = JSON.stringify(argsObj);

      // Include metadata with thoughtSignature if present
      const startEvent: any = { type: ToolCallEventType.TOOL_CALL_START, callId: 'call-0', name };
      if (fc.thoughtSignature) {
        startEvent.metadata = { thoughtSignature: fc.thoughtSignature };
      }

      result.toolEvents = [
        startEvent as ToolCallEvent,
        { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'call-0', argumentsDelta: argsStr } as ToolCallEvent,
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'call-0', name, arguments: argsStr } as ToolCallEvent
      ];

      // Track that we've seen a tool call in this stream
      this.seenToolCallsInStream = true;
    }

    // Google finishes with STOP when tool calls are made
    // Check if this chunk has STOP and we've seen tool calls (could be in previous chunks)
    if (candidate.finishReason === 'STOP' && this.seenToolCallsInStream) {
      result.finishedWithToolCalls = true;
      // Reset for next stream
      this.seenToolCallsInStream = false;
    }

    // Extract usage
    const usage = this.extractUsage(chunk.usageMetadata);
    if (usage) result.usage = usage;

    return result;
  }

  /**
   * Extract tool calls from parts array
   */
  private extractToolCalls(parts?: any[]): ToolCall[] | undefined {
    if (!parts || !Array.isArray(parts) || parts.length === 0) return undefined;

    const calls: ToolCall[] = [];
    let idx = 0;

    for (const p of parts) {
      if (p && p.functionCall) {
        const call: ToolCall = {
          id: `call_${idx++}`,
          name: p.functionCall.name || '',
          arguments: p.functionCall.args || {}
        };
        // Capture thoughtSignature if present (required for Gemini reasoning)
        if (p.thoughtSignature) {
          call.metadata = { thoughtSignature: p.thoughtSignature };
        }
        calls.push(call);
      }
    }

    return calls.length ? calls : undefined;
  }

  /**
   * Extract usage stats
   */
  private extractUsage(usage?: any): UsageStats | undefined {
    if (!usage) return undefined;

    const stats: UsageStats = {
      promptTokens: usage.promptTokenCount,
      completionTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount
    };

    // Add reasoning tokens if present
    if (usage.thoughtsTokenCount !== undefined) {
      stats.reasoningTokens = usage.thoughtsTokenCount;
    }

    return stats;
  }

  /**
   * Extract reasoning/thinking from parts array
   */
  private extractReasoning(parts?: any[]): ReasoningData | undefined {
    if (!parts || !Array.isArray(parts) || parts.length === 0) return undefined;

    // Find parts with thought:true and extract text
    const thinkingText = parts
      .filter(p => p.thought === true && typeof p.text === 'string')
      .map(p => p.text)
      .join('');

    if (!thinkingText) return undefined;

    return {
      text: thinkingText,
      metadata: {
        provider: 'google'
      }
    };
  }

  // ==========================================
  // HTTP-based methods (not used for SDK)
  // These are stub implementations
  // ==========================================

  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    throw new Error('Google compat uses SDK methods, not HTTP buildPayload');
  }

  parseResponse(raw: any, model: string): LLMResponse {
    throw new Error('Google compat uses SDK methods, not HTTP parseResponse');
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    // For SDK-based streaming, parse the SDK chunk
    return this.parseSDKChunk(chunk);
  }

  getStreamingFlags(): any {
    return {};
  }

  serializeTools(tools: UnifiedTool[]): any {
    return this.serializeToolsForSDK(tools);
  }

  serializeToolChoice(choice?: ToolChoice): any {
    return this.serializeToolChoiceForSDK(choice);
  }

  applyProviderExtensions(payload: any, _extensions: any): any {
    return payload;
  }
}
