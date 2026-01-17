import type OpenAI from 'openai';
import type { ContentPart, LLMResponse, ToolCall, UsageStats } from '../../../../kernel/index.js';
import { Role, safeJsonParse } from '../../../../kernel/index.js';
import { extractUsageStats, getGlobalUsageSpec, mergeUsageExtractionSpecs } from '../../../../modules/usage/index.js';
import { isNonEmptyString, ToolCallRunMetadata } from './mappings.js';

const ASSISTANTS_USAGE_SPEC = mergeUsageExtractionSpecs(getGlobalUsageSpec(), {
  promptTokens: ['usage', 'prompt_tokens'],
  completionTokens: ['usage', 'completion_tokens'],
  totalTokens: ['usage', 'total_tokens']
});

export function parseUsageFromRun(run: any): UsageStats | undefined {
  return extractUsageStats(run, ASSISTANTS_USAGE_SPEC);
}

export function parseRequiredActionToolCalls(run: any): ToolCall[] {
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

export async function responseFromRun(client: OpenAI, run: any, model: string): Promise<LLMResponse> {
  const usage = parseUsageFromRun(run);

  if (run?.status === 'requires_action' && run?.required_action?.type === 'submit_tool_outputs') {
    const toolCalls = parseRequiredActionToolCalls(run);
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
    const message = await fetchLatestAssistantMessage(client, run.thread_id);
    const content = parseAssistantMessageContent(message);
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

export async function fetchLatestAssistantMessage(client: OpenAI, threadId: string): Promise<any | null> {
  const page = await client.beta.threads.messages.list(threadId, { order: 'desc', limit: 20 });
  const data = (page as any)?.data;
  if (!Array.isArray(data)) {
    return null;
  }

  return data.find((m: any) => m?.role === 'assistant') ?? null;
}

export function parseAssistantMessageContent(message: any): ContentPart[] {
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

export function validateRequiredActionMetadata(metadata: any): metadata is ToolCallRunMetadata {
  return !!metadata && isNonEmptyString(metadata.threadId) && isNonEmptyString(metadata.runId);
}
