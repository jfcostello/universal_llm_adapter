import type { ToolChoice, UnifiedTool } from '../../../../modules/kernel/index.js';

export function serializeTools(tools: UnifiedTool[]): any {
  if (!tools || tools.length === 0) {
    return {};
  }

  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parametersJsonSchema || {
        type: 'object',
        properties: {}
      }
    }))
  };
}

export function serializeToolChoice(choice?: ToolChoice): any {
  if (!choice) return {};

  if (typeof choice === 'string') {
    if (choice === 'auto') {
      return { tool_choice: { type: 'auto' } };
    }
    if (choice === 'none') {
      return {};
    }
    return {};
  }

  if (choice.type === 'single') {
    return {
      tool_choice: {
        type: 'tool',
        name: choice.name
      }
    };
  }

  if (choice.type === 'required') {
    return { tool_choice: { type: 'any' } };
  }

  return {};
}

