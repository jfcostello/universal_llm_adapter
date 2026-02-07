import type { ToolChoice, UnifiedTool } from '../../../../kernel/index.js';

export function serializeToolsForSDK(tools: UnifiedTool[]): any[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parametersJsonSchema || {
      type: 'object',
      properties: {}
    }
  }));
}

export function serializeToolChoiceForSDK(choice?: ToolChoice): any {
  if (!choice) return undefined;

  if (typeof choice === 'string') {
    // Responses API supports the literal modes directly.
    return choice;
  }

  if (choice.type === 'single') {
    // OpenAI Responses API requires an object for function tool forcing.
    return { type: 'function', name: choice.name };
  }

  if (choice.type === 'required') {
    if (choice.allowed.length === 1) {
      return { type: 'function', name: choice.allowed[0] };
    }

    // Constrain available tools to the allowed set and require at least one call.
    // Note: We only support function tools here (adapter tool names).
    return {
      type: 'allowed_tools',
      mode: 'required',
      tools: choice.allowed.map(name => ({ type: 'function', name }))
    };
  }

  return undefined;
}
