import OpenAI, { AzureOpenAI, toFile } from 'openai';
import type {
  ContentPart,
  DocumentContent,
  ICompatModule,
  LLMCallSettings,
  LLMResponse,
  Message,
  ParsedStreamChunk,
  ToolCall,
  ToolChoice,
  UnifiedTool,
  UsageStats
} from '../../../../kernel/index.js';
import { Role, safeJsonParse, ToolCallEventType } from '../../../../kernel/index.js';
import { extractToolResultFromMessage } from '../../../../modules/messages/index.js';
import { extractUsageStats, getGlobalUsageSpec, mergeUsageExtractionSpecs } from '../../../../modules/usage/index.js';

const ASSISTANTS_USAGE_SPEC = mergeUsageExtractionSpecs(getGlobalUsageSpec(), {
  promptTokens: ['usage', 'prompt_tokens'],
  completionTokens: ['usage', 'completion_tokens'],
  totalTokens: ['usage', 'total_tokens']
});

type ToolCallRunMetadata = { threadId: string; runId: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function contentPartsToText(parts: ContentPart[] | undefined): string {
  if (!parts || parts.length === 0) return '';
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text ?? '')
    .join('');
}

function parseUsageFromRun(run: any): UsageStats | undefined {
  return extractUsageStats(run, ASSISTANTS_USAGE_SPEC);
}

export default class OpenAIAssistantsCompat implements ICompatModule {
  /**
   * SDK client selection:
   * - OpenAI: `Authorization: Bearer ...` header or `OPENAI_API_KEY`.
   * - Azure: `api-key` header and `x-azure-endpoint` + `x-openai-api-version` (or env fallbacks).
   */
  private getSDKClient(headers?: Record<string, string>): OpenAI {
    const rawAzureKey = headers?.['api-key'];
    if (isNonEmptyString(rawAzureKey)) {
      const endpoint = headers?.['x-azure-endpoint'] || process.env.AZURE_OPENAI_ENDPOINT;
      const apiVersion = headers?.['x-openai-api-version'] || process.env.OPENAI_API_VERSION;

      if (!isNonEmptyString(endpoint)) {
        throw new Error('Azure endpoint required in headers.x-azure-endpoint or AZURE_OPENAI_ENDPOINT');
      }
      if (!isNonEmptyString(apiVersion)) {
        throw new Error('Azure API version required in headers.x-openai-api-version or OPENAI_API_VERSION');
      }

      return new AzureOpenAI({ apiKey: rawAzureKey, endpoint, apiVersion });
    }

    let apiKey = headers?.Authorization;
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
    return this.buildCreateAndRunParams(model, settings, messages, tools, toolChoice);
  }

  // This compat is SDK-based; for unit/integration tests we treat pre-parsed objects as passthrough.
  parseResponse(raw: any, _model: string): LLMResponse {
    return raw as LLMResponse;
  }

  parseStreamChunk(chunk: any): ParsedStreamChunk {
    if (!chunk || typeof chunk !== 'object') {
      return {};
    }

    const eventType = (chunk as any).event;

    if (eventType === 'thread.message.delta') {
      const content = (chunk as any).data?.delta?.content;
      if (!Array.isArray(content)) return {};

      let text = '';
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text?.value === 'string') {
          text += part.text.value;
        }
      }

      return text ? { text } : {};
    }

    if (eventType === 'thread.run.requires_action') {
      const run = (chunk as any).data;
      const toolCalls = run?.required_action?.submit_tool_outputs?.tool_calls;
      const metadata = { threadId: run?.thread_id, runId: run?.id };

      const toolEvents: any[] = [];
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!call || call.type !== 'function') continue;
          if (!isNonEmptyString(call.id)) continue;

          const name = typeof call.function?.name === 'string' ? call.function.name : undefined;
          const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';

          toolEvents.push({
            type: ToolCallEventType.TOOL_CALL_START,
            callId: call.id,
            name,
            metadata
          });
          toolEvents.push({
            type: ToolCallEventType.TOOL_CALL_END,
            callId: call.id,
            name,
            arguments: args,
            metadata
          });
        }
      }

      return {
        toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
        finishedWithToolCalls: true
      };
    }

    if (eventType === 'thread.run.completed' || eventType === 'thread.run.incomplete') {
      const run = (chunk as any).data;
      const usage = parseUsageFromRun(run);
      return usage ? { usage } : {};
    }

    if (
      eventType === 'thread.run.failed' ||
      eventType === 'thread.run.cancelled' ||
      eventType === 'thread.run.expired' ||
      eventType === 'error'
    ) {
      const data = (chunk as any).data;
      const message =
        data?.last_error?.message ||
        data?.message ||
        `OpenAI Assistants stream ended with event: ${String(eventType)}`;
      throw new Error(String(message));
    }

    return {};
  }

  getStreamingFlags(): any {
    return { stream: true };
  }

  serializeTools(tools: UnifiedTool[]): any {
    const sdkTools = this.serializeToolsForSDK(tools);
    return sdkTools.length > 0 ? { tools: sdkTools } : {};
  }

  serializeToolChoice(choice?: ToolChoice): any {
    const toolChoice = this.serializeToolChoiceForSDK(choice);
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

    const params = await this.buildCreateAndRunParamsForSDK(client, model, settings, messages, tools, toolChoice);
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

    const params = await this.buildCreateAndRunParamsForSDK(client, model, settings, messages, tools, toolChoice, {
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
        if (next.role !== Role.TOOL) continue;
        const callId = next.toolCallId;
        if (!isNonEmptyString(callId) || !callIds.has(callId)) continue;

        const extracted = extractToolResultFromMessage(next)!;
        toolOutputs.push({ tool_call_id: callId, output: extracted.text });
      }

      if (toolOutputs.length === 0) {
        return null;
      }

      return { threadId: meta.threadId, runId: meta.runId, toolOutputs };
    }

    return null;
  }

  private buildCreateAndRunParams(
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice
  ): any {
    const assistantId = settings.assistantId;
    const instructions = this.extractInstructions(messages);

    const params: any = {
      assistant_id: assistantId,
      model,
      thread: {
        messages: this.serializeThreadMessages(messages)
      }
    };

    if (isNonEmptyString(instructions)) {
      params.instructions = instructions;
    }

    if (settings.temperature !== undefined) {
      params.temperature = settings.temperature;
    }
    if (settings.topP !== undefined) {
      params.top_p = settings.topP;
    }
    if (settings.maxTokens !== undefined) {
      params.max_completion_tokens = settings.maxTokens;
    }
    if (settings.responseFormat) {
      params.response_format = { type: settings.responseFormat };
    }

    const includeFileSearchTool = this.shouldIncludeFileSearchTool(toolChoice) && this.hasDocumentParts(messages);
    const { sdkTools, sdkToolChoice } = this.buildToolsAndChoice(tools, toolChoice, { includeFileSearchTool });
    if (sdkTools.length > 0) {
      params.tools = sdkTools;
    }
    if (sdkToolChoice !== undefined) {
      params.tool_choice = sdkToolChoice;
    }

    return params;
  }

  private async buildCreateAndRunParamsForSDK(
    client: OpenAI,
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    options: { stream?: boolean } = {}
  ): Promise<any> {
    const params = this.buildCreateAndRunParams(model, settings, messages, tools, toolChoice);

    if (options.stream) {
      params.stream = true;
    }

    const fileIds = await this.collectDocumentFileIds(client, messages);
    if (fileIds.length > 0) {
      params.thread.tool_resources = {
        ...(params.thread.tool_resources ?? {}),
        file_search: {
          vector_stores: [
            {
              file_ids: fileIds
            }
          ]
        }
      };
    }

    return params;
  }

  private buildToolsAndChoice(
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    options: { includeFileSearchTool?: boolean } = {}
  ): { sdkTools: any[]; sdkToolChoice: any | undefined } {
    let filteredTools = tools;
    let sdkToolChoice = this.serializeToolChoiceForSDK(toolChoice);

    if (toolChoice && typeof toolChoice === 'object') {
      if (toolChoice.type === 'single') {
        filteredTools = tools.filter(t => t.name === toolChoice.name);
      } else if (toolChoice.type === 'required' && Array.isArray(toolChoice.allowed) && toolChoice.allowed.length > 0) {
        filteredTools = tools.filter(t => toolChoice.allowed.includes(t.name));
      }
    }

    if (toolChoice === 'none') {
      filteredTools = [];
      sdkToolChoice = 'none';
    }

    const sdkTools = this.serializeToolsForSDK(filteredTools);

    if (options.includeFileSearchTool && toolChoice !== 'none') {
      sdkTools.push({ type: 'file_search' });
    }

    return { sdkTools, sdkToolChoice };
  }

  private hasDocumentParts(messages: Message[]): boolean {
    for (const msg of messages) {
      const parts = msg?.content ?? [];
      for (const part of parts) {
        if (part?.type === 'document') return true;
      }
    }
    return false;
  }

  private shouldIncludeFileSearchTool(toolChoice?: ToolChoice): boolean {
    if (!toolChoice) return true;
    if (typeof toolChoice === 'string') {
      return toolChoice !== 'required';
    }
    return false;
  }

  private async collectDocumentFileIds(client: OpenAI, messages: Message[]): Promise<string[]> {
    const fileIds: string[] = [];

    for (const msg of messages) {
      const parts = msg?.content ?? [];
      for (const part of parts) {
        if (part?.type !== 'document') continue;

        const doc = part as DocumentContent;

        if (doc.source.type === 'url') {
          throw new Error('DocumentContent.source.type "url" is not supported for assistants compat');
        }

        if (doc.source.type === 'file_id') {
          if (isNonEmptyString(doc.source.fileId)) {
            fileIds.push(doc.source.fileId);
          }
          continue;
        }

        if (doc.source.type === 'filepath') {
          const { processDocumentContent } = await import('../../../../modules/documents/index.js');
          const processed = processDocumentContent(doc) as DocumentContent & {
            source: { type: 'base64'; data: string };
            filename: string;
            mimeType: string;
          };
          const buffer = Buffer.from(processed.source.data.replace(/\s+/g, ''), 'base64');
          const file = await toFile(buffer, processed.filename, { type: processed.mimeType });
          const created = await client.files.create({ file, purpose: 'assistants' });
          fileIds.push(created.id);
          continue;
        }

        if (doc.source.type === 'base64') {
          const base64 = String(doc.source.data || '').replace(/\s+/g, '');
          const buffer = Buffer.from(base64, 'base64');
          const filename = doc.filename ?? 'document';
          const file = await toFile(buffer, filename, { type: doc.mimeType });
          const created = await client.files.create({ file, purpose: 'assistants' });
          fileIds.push(created.id);
          continue;
        }
      }
    }

    return fileIds;
  }

  private extractInstructions(messages: Message[]): string | undefined {
    const system = messages.find(m => m.role === Role.SYSTEM);
    if (!system) return undefined;
    const text = contentPartsToText(system.content);
    const trimmed = text.trim();
    return trimmed ? trimmed : undefined;
  }

  private serializeThreadMessages(messages: Message[]): any[] {
    const result: any[] = [];

    for (const msg of messages) {
      if (msg.role !== Role.USER && msg.role !== Role.ASSISTANT) {
        continue;
      }

      const role = msg.role === Role.USER ? 'user' : 'assistant';
      const content = this.serializeMessageContent(msg.content);
      result.push({ role, content: content.length > 0 ? content : '' });
    }

    return result;
  }

  private serializeMessageContent(parts: ContentPart[]): any[] {
    if (!parts || parts.length === 0) return [];

    const result: any[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        result.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'image') {
        result.push({ type: 'image_url', image_url: { url: part.imageUrl } });
        continue;
      }

      if (part.type === 'document') {
        const doc = part as DocumentContent;
        const filename = doc.filename ?? 'document';
        const mimeType = doc.mimeType ?? 'unknown';
        result.push({ type: 'text', text: `\n\n[Document attached: ${filename} (${mimeType})]` });
      }
    }

    return result;
  }

  private serializeToolsForSDK(tools: UnifiedTool[]): any[] {
    if (!tools || tools.length === 0) return [];

    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema || { type: 'object', properties: {} }
      }
    }));
  }

  private serializeToolChoiceForSDK(choice?: ToolChoice): any | undefined {
    if (!choice) return undefined;

    if (typeof choice === 'string') {
      return choice;
    }

    if (choice.type === 'single') {
      return {
        type: 'function',
        function: { name: choice.name }
      };
    }

    if (choice.type === 'required') {
      if (choice.allowed.length === 1) {
        return {
          type: 'function',
          function: { name: choice.allowed[0] }
        };
      }
      return 'required';
    }

    return undefined;
  }

  private async responseFromRun(client: OpenAI, run: any, model: string): Promise<LLMResponse> {
    const usage = parseUsageFromRun(run);

    if (run?.status === 'requires_action' && run?.required_action?.type === 'submit_tool_outputs') {
      const toolCalls = this.parseRequiredActionToolCalls(run);
      return {
        provider: 'openai',
        model,
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: '' }],
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: 'tool_calls',
        usage,
        raw: run
      };
    }

    if (run?.status === 'completed' || run?.status === 'incomplete') {
      const message = await this.fetchLatestAssistantMessage(client, run.thread_id);
      const content = this.parseAssistantMessageContent(message);
      return {
        provider: 'openai',
        model,
        role: Role.ASSISTANT,
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        finishReason: run.status,
        usage,
        raw: { run, message }
      };
    }

    const message = run?.last_error?.message || `Run ended with status: ${run?.status || 'unknown'}`;
    throw new Error(message);
  }

  private parseRequiredActionToolCalls(run: any): ToolCall[] {
    const toolCallsRaw = run?.required_action?.submit_tool_outputs?.tool_calls ?? [];
    if (!Array.isArray(toolCallsRaw)) return [];

    const metadata: ToolCallRunMetadata = { threadId: run.thread_id, runId: run.id };

    return toolCallsRaw
      .filter((call: any) => call?.type === 'function')
      .map((call: any, index: number) => {
        const args = safeJsonParse<Record<string, any>>(call.function?.arguments, {}) as any;
        return {
          id: call.id || `call_${index}`,
          name: call.function?.name || '',
          arguments: args,
          args,
          metadata
        } satisfies ToolCall;
      });
  }

  private async fetchLatestAssistantMessage(client: OpenAI, threadId: string): Promise<any | null> {
    const page = await client.beta.threads.messages.list(threadId, { order: 'desc', limit: 20 });
    const data = (page as any)?.data;
    if (!Array.isArray(data)) {
      return null;
    }

    return data.find((m: any) => m?.role === 'assistant') ?? null;
  }

  private parseAssistantMessageContent(message: any): ContentPart[] {
    const content = message?.content;
    if (!Array.isArray(content)) return [];

    const parts: ContentPart[] = [];
    for (const block of content) {
      if (block?.type === 'text') {
        parts.push({ type: 'text', text: block.text?.value ?? '' });
        continue;
      }
      if (block?.type === 'refusal') {
        parts.push({ type: 'text', text: block.refusal ?? '' });
      }
    }
    return parts;
  }
}
