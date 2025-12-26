import type { ToolChoice, UnifiedTool } from '../../../../kernel/index.js';

export function serializeTools(tools: UnifiedTool[]): any {
  if (!tools || tools.length === 0) {
    return {};
  }

  return {
    tools: tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema || {
          type: 'object',
          properties: {}
        }
      }
    }))
  };
}

export function serializeToolChoice(choice?: ToolChoice): any {
  if (!choice) return {};

  if (typeof choice === 'string') {
    return { tool_choice: choice };
  }

  if (choice.type === 'single') {
    return {
      tool_choice: {
        type: 'function',
        function: { name: choice.name }
      }
    };
  }

  if (choice.type === 'required') {
    if (choice.allowed.length === 1) {
      return {
        tool_choice: {
          type: 'function',
          function: { name: choice.allowed[0] }
        }
      };
    }
    return {
      tool_choice: 'required',
      allowed_tools: choice.allowed
    };
  }

  return {};
}

