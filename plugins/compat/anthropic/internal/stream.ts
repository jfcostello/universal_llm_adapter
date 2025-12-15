import type { ParsedStreamChunk, ReasoningData, UsageStats } from '../../../../modules/kernel/index.js';
import { ToolCallEventType } from '../../../../modules/kernel/index.js';
import { extractUsageStats as extractUsageStatsGeneric } from '../../../../modules/usage/index.js';
import { ANTHROPIC_USAGE_SPEC } from './mappings.js';

export interface AnthropicStreamState {
  toolCallState: Map<string, { name?: string; input: string }>;
  contentBlockIndexToCallId: Map<number, string>;
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    toolCallState: new Map(),
    contentBlockIndexToCallId: new Map()
  };
}

export function extractUsageStats(chunk: any): UsageStats | undefined {
  const usage = chunk.usage ?? chunk.delta?.usage;
  if (!usage) {
    return undefined;
  }

  const extracted = extractUsageStatsGeneric(usage, ANTHROPIC_USAGE_SPEC) ?? {};
  const promptTokens = extracted.promptTokens;
  const completionTokens = extracted.completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    reasoningTokens: extracted.reasoningTokens
  };
}

export function extractReasoning(chunk: any): ReasoningData | undefined {
  const candidate = chunk.delta?.thinking ?? chunk.delta?.analysis ?? chunk.thinking;
  if (!candidate) {
    return undefined;
  }

  if (typeof candidate === 'string') {
    return {
      text: candidate,
      metadata: { provider: 'anthropic' }
    };
  }

  if (candidate.text) {
    return {
      text: candidate.text,
      metadata: {
        provider: 'anthropic',
        ...candidate.metadata
      }
    };
  }

  if (Array.isArray(candidate.content)) {
    const textParts = candidate.content
      .map((part: any) => part?.text)
      .filter((part: any): part is string => typeof part === 'string');
    if (textParts.length > 0) {
      return {
        text: textParts.join(''),
        metadata: {
          provider: 'anthropic',
          ...candidate.metadata
        }
      };
    }
  }

  return undefined;
}

export function parseStreamChunk(chunk: any, state: AnthropicStreamState): ParsedStreamChunk {
  const result: ParsedStreamChunk = {};

  if (chunk.type === 'message_start') {
    state.toolCallState.clear();
    state.contentBlockIndexToCallId.clear();
  } else if (chunk.type === 'content_block_start') {
    const block = chunk.content_block;
    const blockIndex = chunk.index;

    if (block.type === 'tool_use') {
      const callId = block.id;
      state.toolCallState.set(callId, { name: block.name, input: '' });
      state.contentBlockIndexToCallId.set(blockIndex, callId);

      result.toolEvents = [
        {
          type: ToolCallEventType.TOOL_CALL_START,
          callId,
          name: block.name
        }
      ];
    }
  } else if (chunk.type === 'content_block_delta') {
    const delta = chunk.delta;

    if (delta.type === 'text_delta') {
      result.text = delta.text;
    } else if (delta.type === 'input_json_delta') {
      const blockIndex = chunk.index;
      const callId = state.contentBlockIndexToCallId.get(blockIndex);

      if (callId) {
        const callState = state.toolCallState.get(callId);
        if (callState) {
          callState.input += delta.partial_json;

          result.toolEvents = [
            {
              type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
              callId,
              argumentsDelta: delta.partial_json
            }
          ];
        }
      }
    }
  } else if (chunk.type === 'content_block_stop') {
    const blockIndex = chunk.index;
    const callId = state.contentBlockIndexToCallId.get(blockIndex);

    if (callId) {
      const callState = state.toolCallState.get(callId);
      if (callState) {
        result.toolEvents = [
          {
            type: ToolCallEventType.TOOL_CALL_END,
            callId,
            name: callState.name,
            arguments: callState.input
          }
        ];
      }
    }
  } else if (chunk.type === 'message_delta') {
    if (chunk.delta?.stop_reason === 'tool_use') {
      result.finishedWithToolCalls = true;
    }
  } else if (chunk.type === 'message_stop') {
    state.toolCallState.clear();
    state.contentBlockIndexToCallId.clear();
  }

  const usage = extractUsageStats(chunk);
  if (usage) {
    result.usage = usage;
  }

  const reasoning = extractReasoning(chunk);
  if (reasoning) {
    result.reasoning = reasoning;
  }

  return result;
}

