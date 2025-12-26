import type {
  ContentPart,
  LLMResponse,
  ReasoningData,
  TextContent,
  ToolCall,
  UsageStats
} from '../../../../kernel/index.js';
import { Role } from '../../../../kernel/index.js';
import { extractUsageStats, getGlobalUsageSpec, mergeUsageExtractionSpecs } from '../../../../modules/usage/index.js';
import type { UsageExtractionSpec } from '../../../../modules/usage/index.js';

const googleUsageSpec: UsageExtractionSpec = {
  promptTokens: [
    { mode: 'sum', paths: [['usageMetadata', 'promptTokenCount'], ['usageMetadata', 'cachedContentTokenCount']] },
    { mode: 'sum', paths: [['promptTokenCount'], ['cachedContentTokenCount']] }
  ],
  completionTokens: [
    ['usageMetadata', 'candidatesTokenCount'],
    ['candidatesTokenCount']
  ],
  totalTokens: [
    ['usageMetadata', 'totalTokenCount'],
    ['totalTokenCount']
  ],
  reasoningTokens: [
    ['usageMetadata', 'thoughtsTokenCount'],
    ['thoughtsTokenCount']
  ],
  cachedTokens: [
    ['usageMetadata', 'cachedContentTokenCount'],
    ['cachedContentTokenCount']
  ],
  promptTokensIncludeCached: true
};

const GOOGLE_USAGE_SPEC = mergeUsageExtractionSpecs(getGlobalUsageSpec(), googleUsageSpec);

export function extractToolCalls(parts?: any[]): ToolCall[] | undefined {
  if (!parts || !Array.isArray(parts) || parts.length === 0) return undefined;

  const calls: ToolCall[] = [];
  let idx = 0;
  let lastThoughtSignature: string | undefined;

  for (const p of parts) {
    if (p && p.functionCall) {
      if (typeof p.thoughtSignature === 'string' && p.thoughtSignature.trim() !== '') {
        lastThoughtSignature = p.thoughtSignature;
      }

      const call: ToolCall = {
        id: `call_${idx++}`,
        name: p.functionCall.name || '',
        arguments: p.functionCall.args || {}
      };

      // Thought signatures: some responses omit thoughtSignature on later tool calls.
      // Preserve the last seen signature to satisfy follow-up tool call requirements.
      const thoughtSignature = typeof p.thoughtSignature === 'string' && p.thoughtSignature.trim() !== ''
        ? p.thoughtSignature
        : lastThoughtSignature;

      if (thoughtSignature) {
        call.metadata = { thoughtSignature };
      }

      calls.push(call);
    }
  }

  return calls.length ? calls : undefined;
}

export function extractUsage(usage?: unknown): UsageStats | undefined {
  return extractUsageStats(usage, GOOGLE_USAGE_SPEC);
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
