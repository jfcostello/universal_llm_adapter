import type { ParsedStreamChunk } from '../../../../kernel/index.js';
import { ToolCallEventType } from '../../../../kernel/index.js';
import { isNonEmptyString } from './mappings.js';
import { parseUsageFromRun } from './response.js';

export function parseSDKChunk(chunk: any): ParsedStreamChunk {
  if (!chunk || typeof chunk !== 'object') {
    return {};
  }

  const eventType = (chunk as any).event;

  if (eventType === 'thread.message.delta') {
    const content = (chunk as any).data?.delta?.content;
    if (!Array.isArray(content)) return {};

    let text = '';
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text?.value === 'string') {
        text += part.text.value;
      }
    }

    return text ? { text } : {};
  }

  if (eventType === 'thread.run.requires_action') {
    const run = (chunk as any).data;
    const toolCalls = run?.required_action?.submit_tool_outputs?.tool_calls;
    const metadata = { threadId: run?.thread_id, runId: run?.id };

    const toolEvents: any[] = [];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!call || call.type !== 'function') continue;
        if (!isNonEmptyString(call.id)) continue;

        const name = typeof call.function?.name === 'string' ? call.function.name : undefined;
        const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';

        toolEvents.push({
          type: ToolCallEventType.TOOL_CALL_START,
          callId: call.id,
          name,
          metadata
        });
        toolEvents.push({
          type: ToolCallEventType.TOOL_CALL_END,
          callId: call.id,
          name,
          arguments: args,
          metadata
        });
      }
    }

    return {
      toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
      finishedWithToolCalls: true
    };
  }

  if (eventType === 'thread.run.completed' || eventType === 'thread.run.incomplete') {
    const run = (chunk as any).data;
    const usage = parseUsageFromRun(run);
    return usage ? { usage } : {};
  }

  if (
    eventType === 'thread.run.failed' ||
    eventType === 'thread.run.cancelled' ||
    eventType === 'thread.run.expired' ||
    eventType === 'error'
  ) {
    const data = (chunk as any).data;
    const message =
      data?.last_error?.message ||
      data?.message ||
      `OpenAI Assistants stream ended with event: ${String(eventType)}`;
    throw new Error(String(message));
  }

  return {};
}

