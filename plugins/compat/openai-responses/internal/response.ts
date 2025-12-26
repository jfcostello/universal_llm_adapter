import type { ContentPart, LLMResponse, TextContent, ToolCall, UsageStats } from '../../../../kernel/index.js';
import { Role, safeJsonParse } from '../../../../kernel/index.js';
import { extractUsageStats, getGlobalUsageSpec, mergeUsageExtractionSpecs } from '../../../../modules/usage/index.js';

const responsesUsageSpec = {
  promptTokens: ['usage', 'input_tokens'],
  completionTokens: ['usage', 'output_tokens'],
  totalTokens: ['usage', 'total_tokens']
};

const OPENAI_RESPONSES_USAGE_SPEC = mergeUsageExtractionSpecs(
  getGlobalUsageSpec(),
  responsesUsageSpec
);

export function parseUsage(usage: unknown): UsageStats | undefined {
  return extractUsageStats(usage, OPENAI_RESPONSES_USAGE_SPEC);
}

export function parseSDKResponse(raw: any, model: string): LLMResponse {
  const output = raw?.output || [];

  const textContent: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of output) {
    if (item?.type === 'message' && item.content) {
      for (const contentItem of item.content) {
        if (contentItem?.type === 'output_text') {
          textContent.push({ type: 'text', text: contentItem.text || '' } as TextContent);
        }
      }
      continue;
    }

    if (item?.type === 'output_text') {
      textContent.push({ type: 'text', text: item.text || '' } as TextContent);
      continue;
    }

    if (item?.type === 'function_call') {
      const parsedArgs = safeJsonParse<Record<string, any>>(item.arguments, {}) as Record<string, any>;
      toolCalls.push({
        id: item.call_id || `call_${toolCalls.length}`,
        name: item.name || '',
        arguments: parsedArgs
      });
    }
  }

  const usage = parseUsage(raw?.usage);

  let finishReason = raw?.status;
  if (toolCalls.length > 0 && textContent.length === 0) {
    finishReason = 'tool_calls';
  }

  return {
    provider: 'openai',
    model,
    role: Role.ASSISTANT,
    content: textContent.length > 0 ? textContent : [{ type: 'text', text: '' } as TextContent],
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    usage,
    raw
  };
}
