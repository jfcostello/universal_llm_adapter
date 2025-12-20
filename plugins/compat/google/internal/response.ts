import type {
  ContentPart,
  LLMResponse,
  ReasoningData,
  TextContent,
  ToolCall,
  UsageStats
} from '../../../../modules/kernel/index.js';
import { Role } from '../../../../modules/kernel/index.js';
import { extractUniversalUsageStats } from '../../../../modules/usage/index.js';

const googleUsageSpec = {
  promptTokens: 'promptTokenCount',
  completionTokens: 'candidatesTokenCount',
  totalTokens: 'totalTokenCount',
  reasoningTokens: 'thoughtsTokenCount'
} as const;

export function extractToolCalls(parts?: any[]): ToolCall[] | undefined {
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

export function extractUsage(usage?: unknown): UsageStats | undefined {
  return extractUniversalUsageStats(usage, googleUsageSpec);
}

export function extractReasoning(parts?: any[]): ReasoningData | undefined {
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

export function parseSDKResponse(raw: any, model: string): LLMResponse {
  const candidate = (raw.candidates && raw.candidates[0]) || {};
  const parts: any[] = candidate.content?.parts || [];

  const content: ContentPart[] = parts
    .filter(p => typeof p?.text === 'string' && p.thought !== true)
    .map(p => ({ type: 'text', text: p.text } as TextContent));

  const toolCalls = extractToolCalls(parts);
  const usage = extractUsage(raw.usageMetadata);
  const reasoning = extractReasoning(parts);

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
