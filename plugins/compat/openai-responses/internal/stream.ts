import type { ParsedStreamChunk, ToolCallEvent, UsageStats } from '../../../../kernel/index.js';
import { ToolCallEventType } from '../../../../kernel/index.js';
import { parseUsage } from './response.js';

export interface OpenAIResponsesToolCallStateItem {
  callId: string;
  name: string;
  arguments: string;
}

export interface OpenAIResponsesStreamState {
  toolCallState: Map<string, OpenAIResponsesToolCallStateItem>;
  seenToolCallsInStream: boolean;
}

export function createOpenAIResponsesStreamState(): OpenAIResponsesStreamState {
  return { toolCallState: new Map(), seenToolCallsInStream: false };
}

export function resetOpenAIResponsesStreamState(state: OpenAIResponsesStreamState): void {
  state.toolCallState.clear();
  state.seenToolCallsInStream = false;
}

export function parseSDKChunk(event: any, state: OpenAIResponsesStreamState): ParsedStreamChunk {
  const result: ParsedStreamChunk = {};
  const eventType = event?.type;

  if (eventType === 'response.output_text.delta') {
    result.text = event.delta;
  }

  if (eventType === 'response.output_item.added' && event.item?.type === 'function_call') {
    const itemId = event.item.id;
    const callId = event.item.call_id;
    const name = event.item.name;

    state.toolCallState.set(itemId, { callId, name, arguments: '' });
    state.seenToolCallsInStream = true;

    result.toolEvents = [
      {
        type: ToolCallEventType.TOOL_CALL_START,
        callId,
        name
      } as ToolCallEvent
    ];
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const itemId = event.item_id;
    const delta = event.delta;

    const existing = state.toolCallState.get(itemId);
    if (existing) {
      existing.arguments += String(delta);

      result.toolEvents = [
        {
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: existing.callId,
          argumentsDelta: delta
        } as ToolCallEvent
      ];
    }
  }

  if (eventType === 'response.function_call_arguments.done') {
    const itemId = event.item_id;
    const args = event.arguments;

    const existing = state.toolCallState.get(itemId);
    if (existing) {
      result.toolEvents = [
        {
          type: ToolCallEventType.TOOL_CALL_END,
          callId: existing.callId,
          name: existing.name,
          arguments: args
        } as ToolCallEvent
      ];

      state.toolCallState.delete(itemId);
    }
  }

  if (eventType === 'response.completed') {
    if (state.seenToolCallsInStream) {
      result.finishedWithToolCalls = true;
      state.seenToolCallsInStream = false;
    }

    state.toolCallState.clear();

    if (event.response?.usage) {
      result.usage = parseUsage(event.response.usage) as UsageStats | undefined;
    }
  }

  return result;
}

