import type { ParsedStreamChunk, ToolCallEvent, UsageStats } from '../../../../modules/kernel/index.js';
import { ToolCallEventType } from '../../../../modules/kernel/index.js';
import { extractReasoning, extractUsage } from './response.js';

export interface GoogleStreamState {
  seenToolCallsInStream: boolean;
}

export function createGoogleStreamState(): GoogleStreamState {
  return { seenToolCallsInStream: false };
}

export function resetGoogleStreamState(state: GoogleStreamState): void {
  state.seenToolCallsInStream = false;
}

export function parseSDKChunk(chunk: any, state: GoogleStreamState): ParsedStreamChunk {
  const result: ParsedStreamChunk = {};
  const candidate = (chunk.candidates && chunk.candidates[0]) || {};
  const parts: any[] = candidate.content?.parts || [];

  // Extract text (excluding thought parts)
  const text = parts
    .filter(p => typeof p?.text === 'string' && p.thought !== true)
    .map(p => p.text)
    .join('');
  if (text) result.text = text;

  // Extract reasoning/thinking
  const reasoning = extractReasoning(parts);
  if (reasoning) result.reasoning = reasoning;

  // Extract function calls
  const fc = parts.find(p => p.functionCall);
  if (fc && fc.functionCall) {
    const name = fc.functionCall.name || '';
    const argsObj = fc.functionCall.args || {};
    const argsStr = JSON.stringify(argsObj);

    // Include metadata with thoughtSignature if present
    const startEvent: any = { type: ToolCallEventType.TOOL_CALL_START, callId: 'call-0', name };
    if (fc.thoughtSignature) {
      startEvent.metadata = { thoughtSignature: fc.thoughtSignature };
    }

    result.toolEvents = [
      startEvent as ToolCallEvent,
      { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'call-0', argumentsDelta: argsStr } as ToolCallEvent,
      { type: ToolCallEventType.TOOL_CALL_END, callId: 'call-0', name, arguments: argsStr } as ToolCallEvent
    ];

    // Track that we've seen a tool call in this stream
    state.seenToolCallsInStream = true;
  }

  // Google finishes with STOP when tool calls are made.
  // Check if this chunk has STOP and we've seen tool calls (could be in previous chunks).
  if (candidate.finishReason === 'STOP' && state.seenToolCallsInStream) {
    result.finishedWithToolCalls = true;
    // Reset for next stream
    state.seenToolCallsInStream = false;
  }

  // Extract usage
  const usage = extractUsage(chunk.usageMetadata) as UsageStats | undefined;
  if (usage) result.usage = usage;

  return result;
}

