import { safeJsonParse } from '../../../../../../../kernel/index.js';

import { normalizePlainObject } from '../shared.js';

export type ExtractedToolCall = { toolCallId: string; name: string; args: Record<string, any>; parseError?: string };

export function normalizeToolArgs(value: any): Record<string, any> {
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    if (parsed === undefined) {
      throw new Error('invalid_tool_arguments');
    }
    return normalizePlainObject(parsed);
  }
  return normalizePlainObject(value);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!, index);
      }
    })()
  );

  await Promise.all(workers);
  return results;
}

export function extractToolCallsFromMessage(message: Record<string, any>): ExtractedToolCall[] {
  const toolCalls: ExtractedToolCall[] = [];

  const seen = new Set<string>();
  const pushToolCall = (toolCall: ExtractedToolCall) => {
    const toolCallId = String(toolCall.toolCallId).trim();
    if (seen.has(toolCallId)) return;
    seen.add(toolCallId);
    toolCalls.push(toolCall);
  };

  const toolCallList = Array.isArray((message as any).toolCallList) ? (message as any).toolCallList : [];
  for (const raw of toolCallList) {
    const obj = normalizePlainObject(raw);
    const toolCallId = String(obj.id ?? obj.toolCallId ?? '').trim();
    const name = String(obj.name ?? obj.function?.name ?? '').trim();
    if (!toolCallId || !name) continue;

    const argsRaw =
      obj.parameters ??
      obj.arguments ??
      obj.function?.parameters ??
      obj.function?.arguments;

    let args: Record<string, any> = {};
    let parseError: string | undefined;
    try {
      args = normalizeToolArgs(argsRaw);
    } catch {
      parseError = 'invalid_tool_arguments';
      args = {};
    }
    pushToolCall({ toolCallId, name, args, ...(parseError ? { parseError } : {}) });
  }

  const toolWithToolCallList = Array.isArray((message as any).toolWithToolCallList) ? (message as any).toolWithToolCallList : [];
  for (const raw of toolWithToolCallList) {
    const obj = normalizePlainObject(raw);
    const toolCall = normalizePlainObject(obj.toolCall);
    const toolCallId = String(toolCall.id ?? obj.toolCallId ?? '').trim();
    const name = String(obj.name ?? toolCall.name ?? toolCall.function?.name ?? '').trim();
    if (!toolCallId || !name) continue;
    const argsRaw =
      toolCall.parameters ??
      toolCall.arguments ??
      toolCall.function?.parameters ??
      toolCall.function?.arguments;
    let args: Record<string, any> = {};
    let parseError: string | undefined;
    try {
      args = normalizeToolArgs(argsRaw);
    } catch {
      parseError = 'invalid_tool_arguments';
      args = {};
    }
    pushToolCall({ toolCallId, name, args, ...(parseError ? { parseError } : {}) });
  }

  return toolCalls;
}
