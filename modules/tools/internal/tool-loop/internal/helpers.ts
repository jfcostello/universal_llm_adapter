import type { ToolCall, ToolChoice, UnifiedTool } from '../../../../../kernel/index.js';

import { sanitizeToolName } from '../../tool-names.js';

const TERMINAL_TOOL_RESULT_OVERRIDE_KEY = 'tool_type_response_override_terminal';

export function resolveFollowUpToolChoice(
  toolChoice: ToolChoice | undefined,
  calledTools: ReadonlySet<string>
): ToolChoice | undefined {
  // `toolChoice: "required"` is intended to ensure *at least one* tool call occurs on the initial turn.
  // After tools have been executed, relax to auto to avoid providers that interpret required as
  // "must keep calling tools" (preventing a final assistant response).
  if (toolChoice === 'required') {
    return 'auto';
  }

  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'required') {
    const allowed = Array.isArray(toolChoice.allowed) ? toolChoice.allowed : [];
    if (allowed.length === 0) {
      return 'auto';
    }

    const remainingAllowed = allowed.filter(name => {
      if (calledTools.has(name)) return false;
      const sanitized = sanitizeToolName(name);
      return !calledTools.has(sanitized);
    });

    if (remainingAllowed.length === 0) {
      return 'auto';
    }

    // If only one allowed tool remains, force it explicitly to reduce the chance of the model
    // emitting a final answer without calling the required remaining tool.
    if (remainingAllowed.length === 1) {
      return { type: 'single', name: sanitizeToolName(remainingAllowed[0]) };
    }

    return toolChoice;
  }

  return toolChoice;
}

export function resolveTerminalOverride(invocationResult: unknown): boolean | undefined {
  if (!invocationResult || typeof invocationResult !== 'object') {
    return undefined;
  }

  const record = invocationResult as Record<string, any>;
  const direct = record[TERMINAL_TOOL_RESULT_OVERRIDE_KEY];
  if (typeof direct === 'boolean') {
    return direct;
  }

  const nested = record.result;
  if (nested && typeof nested === 'object') {
    const nestedValue = (nested as Record<string, any>)[TERMINAL_TOOL_RESULT_OVERRIDE_KEY];
    if (typeof nestedValue === 'boolean') {
      return nestedValue;
    }
  }

  return undefined;
}

export function isToolTerminalByDefinition(toolName: string, toolByName: Map<string, UnifiedTool>): boolean {
  const direct = toolByName.get(toolName);
  if (direct?.terminal === true) {
    return true;
  }

  const sanitized = sanitizeToolName(toolName);
  const sanitizedTool = toolByName.get(sanitized);
  return sanitizedTool?.terminal === true;
}

function resolveToolDefinition(toolName: string, toolByName: Map<string, UnifiedTool>): UnifiedTool | undefined {
  const direct = toolByName.get(toolName);
  if (direct) {
    return direct;
  }

  const sanitized = sanitizeToolName(toolName);
  return toolByName.get(sanitized);
}

export function resolveCallArgTerminalOverride(toolCall: ToolCall, toolByName: Map<string, UnifiedTool>): boolean | undefined {
  const toolDef = resolveToolDefinition(toolCall.name, toolByName);
  const field = typeof toolDef?.toolCallTerminalFlag?.field === 'string'
    ? toolDef.toolCallTerminalFlag.field.trim()
    : '';
  if (!field) {
    return undefined;
  }

  const args = toolCall.arguments as any;
  const value = args ? args[field] : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

export function stripCallArgTerminalFlag(toolCall: ToolCall, toolByName: Map<string, UnifiedTool>): ToolCall {
  const toolDef = resolveToolDefinition(toolCall.name, toolByName);
  const field = typeof toolDef?.toolCallTerminalFlag?.field === 'string'
    ? toolDef.toolCallTerminalFlag.field.trim()
    : '';
  if (!field) {
    return toolCall;
  }

  const args = toolCall.arguments as any;
  if (!args || typeof args !== 'object') {
    return toolCall;
  }

  if (!Object.prototype.hasOwnProperty.call(args, field)) {
    return toolCall;
  }

  const stripped: any = { ...(args as Record<string, any>) };
  delete stripped[field];

  return {
    ...toolCall,
    arguments: stripped,
    args: stripped
  };
}
