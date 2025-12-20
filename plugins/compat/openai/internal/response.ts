import type {
  ContentPart,
  LLMResponse,
  ReasoningData,
  ToolCall,
  UsageStats
} from '../../../../modules/kernel/index.js';
import { Role, safeJsonParse } from '../../../../modules/kernel/index.js';
import { extractUniversalUsageStats } from '../../../../modules/usage/index.js';
import { OPENAI_USAGE_SPEC } from './mappings.js';

function parseContent(content: any): ContentPart[] {
  if (!content) return [];

  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text || '' };
        }
        return null;
      })
      .filter(Boolean) as ContentPart[];
  }

  return [];
}

function parseToolCalls(rawCalls: any, reasoningDetails?: any[]): ToolCall[] | undefined {
  if (!rawCalls || !Array.isArray(rawCalls)) {
    return undefined;
  }

  const encryptedSignatureMap = new Map<string, any>();
  if (reasoningDetails && Array.isArray(reasoningDetails)) {
    for (const detail of reasoningDetails) {
      if (detail?.type === 'reasoning.encrypted' && detail.id) {
        encryptedSignatureMap.set(detail.id, detail);
      }
    }
  }

  return rawCalls.map((call, index) => {
    const toolCall: ToolCall = {
      id: call.id || `call_${index}`,
      name: call.function?.name || '',
      arguments: safeJsonParse(call.function?.arguments, {}) as any
    };

    const encryptedData = call.id ? encryptedSignatureMap.get(call.id) : undefined;
    if (encryptedData) {
      toolCall.metadata = { encryptedSignature: encryptedData };
    }

    return toolCall;
  });
}

function parseUsage(raw: any): UsageStats | undefined {
  const usage = raw?.usage;
  const extracted = extractUniversalUsageStats(raw, OPENAI_USAGE_SPEC);
  if (!usage) {
    return extracted;
  }

  if (!extracted) {
    const fallback: UsageStats = {};
    if (usage.prompt_tokens === null) fallback.promptTokens = null;
    if (usage.completion_tokens === null) fallback.completionTokens = null;
    if (usage.total_tokens === null) fallback.totalTokens = null;
    if (usage.completion_tokens_details?.reasoning_tokens === null) fallback.reasoningTokens = null;
    if (usage.cost === null) fallback.cost = null;
    if (usage.prompt_tokens_details?.cached_tokens === null) fallback.cachedTokens = null;
    if (usage.prompt_tokens_details?.audio_tokens === null) fallback.audioTokens = null;
    return Object.keys(fallback).length > 0 ? fallback : undefined;
  }

  return {
    ...extracted,
    promptTokens: usage.prompt_tokens === null ? null : extracted.promptTokens,
    completionTokens: usage.completion_tokens === null ? null : extracted.completionTokens,
    totalTokens: usage.total_tokens === null ? null : extracted.totalTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens === null
      ? null
      : extracted.reasoningTokens,
    cost: usage.cost === null ? null : extracted.cost,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens === null ? null : extracted.cachedTokens,
    audioTokens: usage.prompt_tokens_details?.audio_tokens === null ? null : extracted.audioTokens
  };
}

function parseReasoning(message: any): ReasoningData | undefined {
  if (!message.reasoning && !message.reasoning_details) return undefined;

  let reasoningText: string | undefined;
  let metadata: Record<string, any> | undefined;

  if (message.reasoning_details) {
    metadata = { rawDetails: message.reasoning_details };
  }

  if (message.reasoning) {
    reasoningText = message.reasoning;
  } else if (message.reasoning_details) {
    const textDetails = message.reasoning_details.filter(
      (detail: any) => detail.type === 'reasoning.text' && detail.text
    );
    if (textDetails.length > 0) {
      reasoningText = textDetails.map((d: any) => d.text).join('');
    } else {
      const summaryDetail = message.reasoning_details.find(
        (detail: any) => detail.type === 'reasoning.summary'
      );
      if (summaryDetail?.summary) {
        reasoningText = summaryDetail.summary;
      }
    }
  }

  if (!reasoningText) return undefined;

  return {
    text: reasoningText,
    ...(metadata && { metadata })
  };
}

export function parseResponse(raw: any, model: string): LLMResponse {
  const choice = (raw.choices || [{}])[0];
  const message = choice.message || {};

  const content: ContentPart[] = parseContent(message.content);
  const toolCalls = parseToolCalls(message.tool_calls, message.reasoning_details);
  const usage = parseUsage(raw);
  const reasoning = parseReasoning(message);

  return {
    provider: raw.provider || 'openai',
    model,
    role: Role.ASSISTANT,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    toolCalls,
    finishReason: choice.finish_reason,
    usage,
    reasoning,
    raw
  };
}
