import type { ParsedStreamChunk, ToolCallEvent, UsageStats } from '../../../../kernel/index.js';
import { ToolCallEventType } from '../../../../kernel/index.js';
import { extractReasoning, extractUsage } from './response.js';

export interface GoogleStreamState {
  seenToolCallsInStream: boolean;
  nextCallId: number;
  lastThoughtSignature?: string;
}

export function createGoogleStreamState(): GoogleStreamState {
  return { seenToolCallsInStream: false, nextCallId: 0 };
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

  // Extract function calls (Gemini streaming can emit multiple functionCall parts)
  const toolEvents: ToolCallEvent[] = [];
  for (const part of parts) {
    if (!part || !part.functionCall) continue;

    const name = part.functionCall.name || '';
    const argsObj = part.functionCall.args || {};
    const argsStr = JSON.stringify(argsObj);

    // Google thought signatures: some streams omit thoughtSignature on later tool calls.
    // Preserve the last seen signature to satisfy follow-up tool call requirements.
    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.trim() !== '') {
      state.lastThoughtSignature = part.thoughtSignature;
    }
    const thoughtSignature = state.lastThoughtSignature;

    const callId = `call-${state.nextCallId++}`;

    const startEvent: any = { type: ToolCallEventType.TOOL_CALL_START, callId, name };
    const metadata = thoughtSignature ? { thoughtSignature } : undefined;
    if (metadata) startEvent.metadata = metadata;

    const endEvent: any = { type: ToolCallEventType.TOOL_CALL_END, callId, name, arguments: argsStr };
    if (metadata) endEvent.metadata = metadata;

    toolEvents.push(
      startEvent as ToolCallEvent,
      { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId, argumentsDelta: argsStr } as ToolCallEvent,
      endEvent as ToolCallEvent
    );

    state.seenToolCallsInStream = true;
  }

  if (toolEvents.length > 0) {
    result.toolEvents = toolEvents;
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
