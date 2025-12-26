import { GoogleGenAI } from '@google/genai';
import type {
  ICompatModule,
  LLMCallSettings,
  Message,
  ParsedStreamChunk,
  ReasoningData,
  ToolChoice,
  ToolCall,
  UnifiedTool,
  UsageStats,
  LLMResponse
} from '../../../../kernel/index.js';
import { extractToolResponse as extractToolResponseFromMessage, serializeMessages as serializeGoogleMessages } from './messages.js';
import {
  extractReasoning as extractGoogleReasoning,
  extractToolCalls as extractGoogleToolCalls,
  extractUsage as extractGoogleUsage,
  parseSDKResponse as parseGoogleSDKResponse
} from './response.js';
import { serializeSettings as serializeGoogleSettings } from './settings.js';
import {
  createGoogleStreamState,
  parseSDKChunk as parseGoogleSDKChunk,
  resetGoogleStreamState
} from './stream.js';
import {
  convertSchemaToGoogleFormat as convertSchemaToGoogleFormatFn,
  serializeToolChoiceForSDK as serializeToolChoiceForGoogleSDK,
  serializeToolsForSDK as serializeToolsForGoogleSDK
} from './tools.js';

export default class GoogleCompat implements ICompatModule {
  private streamState = createGoogleStreamState();

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
   * SDK-based streaming method - uses @google/genai SDK streaming.
   * Yields raw SDK chunks to be parsed by parseStreamChunk().
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
    resetGoogleStreamState(this.streamState);

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

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeMessages(messages: Message[]) {
    return serializeGoogleMessages(messages);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeSettings(settings: LLMCallSettings) {
    return serializeGoogleSettings(settings);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private convertSchemaToGoogleFormat(schema: any) {
    return convertSchemaToGoogleFormatFn(schema);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeToolsForSDK(tools: UnifiedTool[]) {
    return serializeToolsForGoogleSDK(tools);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeToolChoiceForSDK(choice?: ToolChoice, tools?: UnifiedTool[]) {
    return serializeToolChoiceForGoogleSDK(choice, tools);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private parseSDKResponse(raw: any, model: string) {
    return parseGoogleSDKResponse(raw, model);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private parseSDKChunk(chunk: any): ParsedStreamChunk {
    return parseGoogleSDKChunk(chunk, this.streamState);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractToolResponse(message: Message): [string | undefined, any] {
    return extractToolResponseFromMessage(message);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractToolCalls(parts?: any[]): ToolCall[] | undefined {
    return extractGoogleToolCalls(parts);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractUsage(usage?: any): UsageStats | undefined {
    return extractGoogleUsage(usage);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private extractReasoning(parts?: any[]): ReasoningData | undefined {
    return extractGoogleReasoning(parts);
  }
}
