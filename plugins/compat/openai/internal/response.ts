import type {
  ContentPart,
  LLMResponse,
  ReasoningData,
  ToolCall,
  UsageStats
} from '../../../../kernel/index.js';
import { Role, safeJsonParse } from '../../../../kernel/index.js';
import { extractUsageStats, getGlobalUsageSpec, mergeUsageExtractionSpecs } from '../../../../modules/usage/index.js';
import { OPENAI_USAGE_SPEC_RESPONSE } from './mappings.js';

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

const OPENAI_USAGE_SPEC = mergeUsageExtractionSpecs(
  getGlobalUsageSpec(),
  OPENAI_USAGE_SPEC_RESPONSE
);

function parseUsage(raw: any): UsageStats | undefined {
  return extractUsageStats(raw, OPENAI_USAGE_SPEC);
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
