import type { ParsedStreamChunk, ReasoningData, UsageStats } from '../../../../modules/kernel/index.js';
import { ToolCallEventType } from '../../../../modules/kernel/index.js';
import { extractUsageStats, getGlobalUsageSpec, mergeUsageExtractionSpecs, stripNullUsageStats } from '../../../../modules/usage/index.js';
import { OPENAI_USAGE_SPEC_STREAM } from './mappings.js';

export interface OpenAIStreamState {
  toolCallState: Map<string, { name?: string; arguments: string }>;
  sawToolCallsInCurrentChunk: boolean;
  indexToIdMap: Map<string, string>;
}

export function createOpenAIStreamState(): OpenAIStreamState {
  return {
    toolCallState: new Map(),
    sawToolCallsInCurrentChunk: false,
    indexToIdMap: new Map()
  };
}

const OPENAI_STREAM_USAGE_SPEC = mergeUsageExtractionSpecs(
  getGlobalUsageSpec(),
  OPENAI_USAGE_SPEC_STREAM
);

export function normalizeUsageStats(raw: any): UsageStats {
  return stripNullUsageStats(extractUsageStats(raw, OPENAI_STREAM_USAGE_SPEC)) ?? {};
}

export function extractReasoningFromDelta(delta: any): ReasoningData | undefined {
  if (!delta?.reasoning) {
    return undefined;
  }

  const segments = Array.isArray(delta.reasoning) ? delta.reasoning : [delta.reasoning];
  const textParts: string[] = [];
  const metadata: Record<string, any> = {};

  for (const segment of segments) {
    if (!segment) continue;

    if (typeof segment === 'string') {
      textParts.push(segment);
      continue;
    }

    if (typeof segment.text === 'string') {
      textParts.push(segment.text);
    }

    if (Array.isArray(segment.content)) {
      for (const part of segment.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
    }

    if (segment.metadata && typeof segment.metadata === 'object') {
      Object.assign(metadata, segment.metadata);
    }
  }

  if (textParts.length === 0) {
    return undefined;
  }

  return {
    text: textParts.join(''),
    metadata: {
      provider: 'openai',
      ...metadata
    }
  };
}

export function parseStreamChunk(chunk: any, state: OpenAIStreamState): ParsedStreamChunk {
  const result: ParsedStreamChunk = {};

  const choices = chunk.choices || [];
  if (choices.length === 0) return result;

  const choice = choices[0];
  const delta = choice.delta || {};

  if (delta.content) {
    result.text = delta.content;
  }

  state.sawToolCallsInCurrentChunk = false;

  const encryptedSignatureMap = new Map<string, any>();
  if (delta.reasoning_details && Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      if (detail.type === 'reasoning.encrypted' && detail.id) {
        encryptedSignatureMap.set(detail.id, detail);
      }
    }
  }

  if (delta.tool_calls) {
    state.sawToolCallsInCurrentChunk = true;
    result.toolEvents = [];
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.index !== undefined) {
        state.indexToIdMap.set(String(toolCall.index), toolCall.id);
      }

      let callId: string | undefined = toolCall.id;
      if (!callId && toolCall.index !== undefined) {
        callId = state.indexToIdMap.get(String(toolCall.index)) || String(toolCall.index);
      }

      const callIdKey = callId ?? 'call_0';
      const stateEntry = state.toolCallState.get(callIdKey) || { arguments: '' };

      if (toolCall.function?.name && !stateEntry.name) {
        stateEntry.name = toolCall.function.name;
        state.toolCallState.set(callIdKey, stateEntry);

        const startEvent: any = {
          type: ToolCallEventType.TOOL_CALL_START,
          callId: callIdKey,
          name: stateEntry.name
        };

        const encryptedData = encryptedSignatureMap.get(callIdKey);
        if (encryptedData) {
          startEvent.metadata = { encryptedSignature: encryptedData };
        }

        result.toolEvents.push(startEvent);
      }

      if (toolCall.function?.arguments) {
        stateEntry.arguments += toolCall.function.arguments;

        result.toolEvents.push({
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: callIdKey,
          argumentsDelta: toolCall.function.arguments
        });
      }
    }
  }

  if (choice.finish_reason === 'tool_calls') {
    result.finishedWithToolCalls = true;

    if (!result.toolEvents) {
      result.toolEvents = [];
    }

    if (state.sawToolCallsInCurrentChunk && state.toolCallState.size > 0) {
      for (const [callId, callState] of state.toolCallState.entries()) {
        result.toolEvents.push({
          type: ToolCallEventType.TOOL_CALL_END,
          callId,
          name: callState.name,
          arguments: callState.arguments
        });
      }
    }

    state.toolCallState.clear();
    state.indexToIdMap.clear();
    state.sawToolCallsInCurrentChunk = false;
  }

  if (choice.finish_reason && choice.finish_reason !== 'tool_calls') {
    state.toolCallState.clear();
    state.indexToIdMap.clear();
    state.sawToolCallsInCurrentChunk = false;
  }

  if (chunk.usage) {
    result.usage = normalizeUsageStats(chunk.usage);
  }

  const reasoning = extractReasoningFromDelta(delta);
  if (reasoning) {
    result.reasoning = reasoning;
  }

  return result;
}
