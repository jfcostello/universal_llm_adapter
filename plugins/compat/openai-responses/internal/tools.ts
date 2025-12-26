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
    if (choice === 'none') {
      return undefined;
    }
    return choice;
  }

  if (choice.type === 'single') {
    return choice.name;
  }

  if (choice.type === 'required') {
    return 'required';
  }

  return undefined;
}

