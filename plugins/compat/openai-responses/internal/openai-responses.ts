import OpenAI from 'openai';
import type {
  ICompatModule,
  LLMCallSettings,
  Message,
  ParsedStreamChunk,
  ToolChoice,
  UnifiedTool,
  LLMResponse
} from '../../../../kernel/index.js';
import { serializeMessages as serializeOpenAIResponsesMessages } from './messages.js';
import { parseSDKResponse as parseOpenAIResponsesSDKResponse } from './response.js';
import { serializeSettings as serializeOpenAIResponsesSettings } from './settings.js';
import {
  createOpenAIResponsesStreamState,
  parseSDKChunk as parseOpenAIResponsesSDKChunk,
  resetOpenAIResponsesStreamState
} from './stream.js';
import {
  serializeToolChoiceForSDK as serializeToolChoiceForOpenAIResponsesSDK,
  serializeToolsForSDK as serializeToolsForOpenAIResponsesSDK
} from './tools.js';

export default class OpenAIResponsesCompat implements ICompatModule {
  private streamState = createOpenAIResponsesStreamState();
  // Intentionally retained for tests (accessed via `(compat as any).toolCallState`).
  private toolCallState = this.streamState.toolCallState;

  /**
   * Get SDK client with API key from headers or environment
   */
  private getSDKClient(headers?: Record<string, string>): OpenAI {
    let apiKey = headers?.Authorization;

    if (apiKey?.startsWith('Bearer ')) {
      apiKey = apiKey.substring(7);
    }

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

    params.stream = true;

    resetOpenAIResponsesStreamState(this.streamState);

    if (logger) {
      logger.info('OpenAI Responses SDK stream params', { model, paramsKeys: Object.keys(params) });
    }

    try {
      const stream = (await client.responses.create(params)) as any;
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

    Object.assign(params, settingsParams);

    if (sdkTools && sdkTools.length > 0) {
      params.tools = sdkTools;
    }

    if (toolChoiceParam !== undefined) {
      params.tool_choice = toolChoiceParam;
    }

    return params;
  }

  parseStreamChunk(event: any): ParsedStreamChunk {
    return this.parseSDKChunk(event);
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  serializeTools(tools: UnifiedTool[]): any {
    const sdkTools = this.serializeToolsForSDK(tools);
    return sdkTools ? { tools: sdkTools } : {};
  }

  serializeToolChoice(choice?: ToolChoice): any {
    const toolChoice = this.serializeToolChoiceForSDK(choice);
    return toolChoice !== undefined ? { tool_choice: toolChoice } : {};
  }

  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    return this.buildSDKParams(model, settings, messages, tools, toolChoice);
  }

  parseResponse(raw: any, model: string): LLMResponse {
    return this.parseSDKResponse(raw, model);
  }

  applyProviderExtensions(payload: any, _extensions: any): any {
    return payload;
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeMessages(messages: Message[]) {
    return serializeOpenAIResponsesMessages(messages);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeSettings(settings: LLMCallSettings) {
    return serializeOpenAIResponsesSettings(settings);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeToolsForSDK(tools: UnifiedTool[]) {
    return serializeToolsForOpenAIResponsesSDK(tools);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private serializeToolChoiceForSDK(choice?: ToolChoice) {
    return serializeToolChoiceForOpenAIResponsesSDK(choice);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private parseSDKResponse(raw: any, model: string) {
    return parseOpenAIResponsesSDKResponse(raw, model);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private parseSDKChunk(event: any): ParsedStreamChunk {
    return parseOpenAIResponsesSDKChunk(event, this.streamState);
  }
}

