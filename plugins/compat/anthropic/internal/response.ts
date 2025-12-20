import type {
  ContentPart,
  LLMResponse,
  ReasoningData,
  ToolCall,
  UsageStats
} from '../../../../modules/kernel/index.js';
import { Role } from '../../../../modules/kernel/index.js';
import { extractUniversalUsageStats } from '../../../../modules/usage/index.js';
import { ANTHROPIC_USAGE_SPEC } from './mappings.js';
import { ANTHROPIC_STOP_REASON_MAP } from './mappings.js';

function parseContent(contentBlocks: any[]): ContentPart[] {
  if (!contentBlocks || !Array.isArray(contentBlocks)) {
    return [];
  }

  return contentBlocks
    .filter(block => block.type === 'text')
    .map(block => ({ type: 'text', text: block.text || '' }));
}

function parseToolCalls(contentBlocks: any[]): ToolCall[] | undefined {
  if (!contentBlocks || !Array.isArray(contentBlocks)) {
    return undefined;
  }

  const toolUseBlocks = contentBlocks.filter(block => block.type === 'tool_use');
  if (toolUseBlocks.length === 0) {
    return undefined;
  }

  return toolUseBlocks.map((block, index) => ({
    id: block.id || `call_${index}`,
    name: block.name || '',
    arguments: block.input || {}
  }));
}

function parseUsage(usage: any): UsageStats | undefined {
  if (!usage) return undefined;
  const extracted = extractUniversalUsageStats({ usage }, ANTHROPIC_USAGE_SPEC) ?? {};
  const promptTokens = usage.input_tokens === null ? null : extracted.promptTokens;
  const completionTokens = usage.output_tokens === null ? null : extracted.completionTokens;
  const totalTokens = extracted.totalTokens ?? (
    (typeof promptTokens === 'number' ? promptTokens : 0) +
    (typeof completionTokens === 'number' ? completionTokens : 0)
  );

  return {
    ...extracted,
    promptTokens,
    completionTokens,
    totalTokens
  };
}

function parseReasoning(contentBlocks: any[]): ReasoningData | undefined {
  if (!contentBlocks || !Array.isArray(contentBlocks)) {
    return undefined;
  }

  const thinkingBlock = contentBlocks.find(block => block.type === 'thinking');
  if (!thinkingBlock || !thinkingBlock.thinking) {
    return undefined;
  }

  const metadata: Record<string, any> = {};
  if (thinkingBlock.signature) {
    metadata.signature = thinkingBlock.signature;
  }

  return {
    text: thinkingBlock.thinking,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
}

function mapStopReason(stopReason: string | undefined): string | undefined {
  if (!stopReason) return undefined;
  return ANTHROPIC_STOP_REASON_MAP[stopReason] || stopReason;
}

export function parseResponse(raw: any, model: string): LLMResponse {
  const content: ContentPart[] = parseContent(raw.content);
  const toolCalls = parseToolCalls(raw.content);
  const usage = parseUsage(raw.usage);
  const reasoning = parseReasoning(raw.content);

  return {
    provider: 'anthropic',
    model,
    role: Role.ASSISTANT,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    toolCalls,
    finishReason: mapStopReason(raw.stop_reason),
    usage,
    reasoning,
    raw
  };
}
