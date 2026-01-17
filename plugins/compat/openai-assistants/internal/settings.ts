import OpenAI, { toFile } from 'openai';
import type { DocumentContent, LLMCallSettings, Message, ToolChoice, UnifiedTool } from '../../../../kernel/index.js';
import { buildToolsAndChoice } from './tools.js';
import { extractInstructions, hasDocumentParts, serializeThreadMessages } from './messages.js';
import { isNonEmptyString } from './mappings.js';

function shouldIncludeFileSearchTool(toolChoice?: ToolChoice): boolean {
  if (!toolChoice) return true;
  if (typeof toolChoice === 'string') {
    return toolChoice !== 'required';
  }
  return false;
}

export function buildCreateAndRunParams(
  model: string,
  settings: LLMCallSettings,
  messages: Message[],
  tools: UnifiedTool[],
  toolChoice?: ToolChoice
): any {
  const assistantId = settings.assistantId;
  const instructions = extractInstructions(messages);

  const params: any = {
    assistant_id: assistantId,
    model,
    thread: {
      messages: serializeThreadMessages(messages)
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

  const includeFileSearchTool = shouldIncludeFileSearchTool(toolChoice) && hasDocumentParts(messages);
  const { sdkTools, sdkToolChoice } = buildToolsAndChoice(tools, toolChoice, { includeFileSearchTool });
  if (sdkTools.length > 0) {
    params.tools = sdkTools;
  }
  if (sdkToolChoice !== undefined) {
    params.tool_choice = sdkToolChoice;
  }

  return params;
}

export async function buildCreateAndRunParamsForSDK(
  client: OpenAI,
  model: string,
  settings: LLMCallSettings,
  messages: Message[],
  tools: UnifiedTool[],
  toolChoice?: ToolChoice,
  options: { stream?: boolean } = {}
): Promise<any> {
  const params = buildCreateAndRunParams(model, settings, messages, tools, toolChoice);

  if (options.stream) {
    params.stream = true;
  }

  const fileIds = await collectDocumentFileIds(client, messages);
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

export async function collectDocumentFileIds(client: OpenAI, messages: Message[]): Promise<string[]> {
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

