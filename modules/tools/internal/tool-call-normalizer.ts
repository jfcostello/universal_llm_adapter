import type { ToolCall } from '../../kernel/index.js';

/**
 * Normalizes tool call argument structures for downstream consumers.
 * Providers may surface arguments under either `arguments` (official schema)
 * or legacy `args` fields. We mirror the canonical `arguments` object onto
 * an `args` alias so existing test assertions and tooling continue to work.
 */
export function normalizeToolCalls(toolCalls?: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return toolCalls;
  }

  return toolCalls.map(call => {
    const args = (call as any).args ?? call.arguments ?? {};

    // Preserve original reference when possible to avoid unnecessary cloning
    if ((call as any).args === args && call.arguments === args) {
      return call;
    }

    return {
      ...call,
      arguments: args,
      // Alias for compatibility with legacy expectations
      args
    } as ToolCall;
  });
}

