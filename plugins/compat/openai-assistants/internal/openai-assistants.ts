import OpenAI, { AzureOpenAI } from 'openai';
import type {
  ICompatModule,
  LLMCallSettings,
  LLMResponse,
  Message,
  ParsedStreamChunk,
  ToolCall,
  ToolChoice,
  UnifiedTool
} from '../../../../kernel/index.js';
import { Role } from '../../../../kernel/index.js';
import { extractToolResultFromMessage } from '../../../../modules/messages/index.js';
import { hasDocumentParts, isToolBudgetFinalPromptMessage } from './messages.js';
import { isNonEmptyString, type ToolCallRunMetadata } from './mappings.js';
import { responseFromRun, parseAssistantMessageContent, parseRequiredActionToolCalls } from './response.js';
import { buildCreateAndRunParams, buildCreateAndRunParamsForSDK, collectDocumentFileIds } from './settings.js';
import { parseSDKChunk } from './stream.js';
import { buildToolsAndChoice, serializeToolChoiceForSDK, serializeToolsForSDK } from './tools.js';

type LowercasedHeaders = Record<string, string | undefined>;

export default class OpenAIAssistantsCompat implements ICompatModule {
  private normalizeHeaders(headers?: Record<string, string>): LowercasedHeaders {
    const out: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      out[String(key).toLowerCase()] = value;
    }
    return out;
  }

  /**
   * SDK client selection:
   * - OpenAI: `Authorization: Bearer ...` header or `OPENAI_API_KEY`.
   * - Azure: `api-key` header and `x-azure-endpoint` + `x-openai-api-version` (or env fallbacks).
   */
  private getSDKClient(headers?: Record<string, string>): OpenAI {
    const normalized = this.normalizeHeaders(headers);

    const rawAzureKey = normalized['api-key'];
    if (isNonEmptyString(rawAzureKey)) {
      const endpoint = normalized['x-azure-endpoint'] || process.env.AZURE_OPENAI_ENDPOINT;
      const apiVersion = normalized['x-openai-api-version'] || process.env.OPENAI_API_VERSION;

      if (!isNonEmptyString(endpoint)) {
        throw new Error('Azure endpoint required in headers.x-azure-endpoint or AZURE_OPENAI_ENDPOINT');
      }
      if (!isNonEmptyString(apiVersion)) {
        throw new Error('Azure API version required in headers.x-openai-api-version or OPENAI_API_VERSION');
      }

      return new AzureOpenAI({ apiKey: rawAzureKey, endpoint, apiVersion });
    }

    let apiKey = normalized.authorization;
    if (apiKey?.startsWith('Bearer ')) {
      apiKey = apiKey.substring(7);
    }
    apiKey = apiKey || process.env.OPENAI_API_KEY;

    if (!isNonEmptyString(apiKey)) {
      throw new Error('API key required in headers.Authorization or OPENAI_API_KEY environment variable');
    }

    return new OpenAI({ apiKey });
  }

  buildPayload(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    return buildCreateAndRunParams(model, settings, messages, tools, toolChoice);
  }

  // This compat is SDK-based; for unit/integration tests we treat pre-parsed objects as passthrough.
  parseResponse(raw: any, _model: string): LLMResponse {
    return raw as LLMResponse;
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    return parseSDKChunk(chunk);
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  serializeTools(tools: UnifiedTool[]): any {
    const sdkTools = serializeToolsForSDK(tools);
    return sdkTools.length > 0 ? { tools: sdkTools } : {};
  }

  serializeToolChoice(choice?: ToolChoice): any {
    const toolChoice = serializeToolChoiceForSDK(choice);
    return toolChoice !== undefined ? { tool_choice: toolChoice } : {};
  }

  async callSDK(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    logger?: any,
    headers?: Record<string, string>
  ): Promise<LLMResponse> {
    const assistantId = settings.assistantId;
    if (!isNonEmptyString(assistantId)) {
      throw new Error('OpenAI Assistants requires settings.assistantId');
    }

    const client = this.getSDKClient(headers);

    const followUp = this.extractToolSubmissionContext(messages);
    if (followUp) {
      const run = await client.beta.threads.runs.submitToolOutputsAndPoll(
        followUp.runId,
        {
          thread_id: followUp.threadId,
          tool_outputs: followUp.toolOutputs
        },
        undefined
      );
      return await this.responseFromRun(client, run, model);
    }

    const params = await buildCreateAndRunParamsForSDK(client, model, settings, messages, tools, toolChoice);
    if (logger?.info) {
      logger.info('OpenAI Assistants SDK createAndRun params', { model, paramsKeys: Object.keys(params) });
    }

    const run = await client.beta.threads.createAndRunPoll(params, undefined);
    return await this.responseFromRun(client, run, model);
  }

  async *streamSDK(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    logger?: any,
    headers?: Record<string, string>
  ): AsyncGenerator<any> {
    const assistantId = settings.assistantId;
    if (!isNonEmptyString(assistantId)) {
      throw new Error('OpenAI Assistants requires settings.assistantId');
    }

    const client = this.getSDKClient(headers);

    const followUp = this.extractToolSubmissionContext(messages);
    if (followUp) {
      const stream = client.beta.threads.runs.submitToolOutputsStream(
        followUp.runId,
        {
          thread_id: followUp.threadId,
          tool_outputs: followUp.toolOutputs,
          stream: true
        },
        undefined
      ) as any;

      for await (const event of stream) {
        yield event;
      }
      return;
    }

    const params = await buildCreateAndRunParamsForSDK(client, model, settings, messages, tools, toolChoice, {
      stream: true
    });
    params.stream = true;

    if (logger?.info) {
      logger.info('OpenAI Assistants SDK createAndRunStream params', { model, paramsKeys: Object.keys(params) });
    }

    const stream = client.beta.threads.createAndRunStream(params, undefined) as any;
    for await (const event of stream) {
      yield event;
    }
  }

  private extractToolSubmissionContext(messages: Message[]): {
    threadId: string;
    runId: string;
    toolOutputs: Array<{ tool_call_id: string; output: string }>;
  } | null {
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      const msg = messages[idx];
      if (msg.role !== Role.ASSISTANT || !msg.toolCalls || msg.toolCalls.length === 0) {
        continue;
      }

      const meta = msg.toolCalls[0].metadata as ToolCallRunMetadata | undefined;
      if (!meta || !isNonEmptyString(meta.threadId) || !isNonEmptyString(meta.runId)) {
        continue;
      }

      const callIds = new Set(msg.toolCalls.map(call => call.id));
      const toolOutputs: Array<{ tool_call_id: string; output: string }> = [];

      for (let j = idx + 1; j < messages.length; j++) {
        const next = messages[j];

        if (next.role === Role.TOOL) {
          const callId = next.toolCallId;
          if (!isNonEmptyString(callId) || !callIds.has(callId)) continue;
          const extracted = extractToolResultFromMessage(next)!;
          toolOutputs.push({ tool_call_id: callId, output: extracted.text });
          continue;
        }

        // Tool budget exhaustion can inject a final prompt after tool results. Preserve the
        // ability to submit tool outputs in that scenario, but do not treat arbitrary new
        // user/assistant turns as tool-output follow-ups.
        if (isToolBudgetFinalPromptMessage(next)) {
          continue;
        }

        return null;
      }

      if (toolOutputs.length === 0) {
        return null;
      }

      return { threadId: meta.threadId, runId: meta.runId, toolOutputs };
    }

    return null;
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private buildToolsAndChoice(
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    options: { includeFileSearchTool?: boolean } = {}
  ): { sdkTools: any[]; sdkToolChoice: any | undefined } {
    return buildToolsAndChoice(tools, toolChoice, options);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private hasDocumentParts(messages: Message[]): boolean {
    return hasDocumentParts(messages);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private async collectDocumentFileIds(client: OpenAI, messages: Message[]): Promise<string[]> {
    return collectDocumentFileIds(client, messages);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private async responseFromRun(client: OpenAI, run: any, model: string): Promise<LLMResponse> {
    return responseFromRun(client, run, model);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private parseRequiredActionToolCalls(run: any): ToolCall[] {
    return parseRequiredActionToolCalls(run);
  }

  // Intentionally retained for tests (accessed via `(compat as any)`).
  private parseAssistantMessageContent(message: any) {
    return parseAssistantMessageContent(message);
  }
}
