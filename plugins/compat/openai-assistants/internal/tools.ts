import type { ToolChoice, UnifiedTool } from '../../../../kernel/index.js';

export function serializeToolsForSDK(tools: UnifiedTool[]): any[] {
  if (!tools || tools.length === 0) return [];

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema || { type: 'object', properties: {} }
    }
  }));
}

export function serializeToolChoiceForSDK(choice?: ToolChoice): any | undefined {
  if (!choice) return undefined;

  if (typeof choice === 'string') {
    return choice;
  }

  if (choice.type === 'single') {
    return {
      type: 'function',
      function: { name: choice.name }
    };
  }

  if (choice.type === 'required') {
    if (choice.allowed.length === 1) {
      return {
        type: 'function',
        function: { name: choice.allowed[0] }
      };
    }
    return 'required';
  }

  return undefined;
}

export function buildToolsAndChoice(
  tools: UnifiedTool[],
  toolChoice?: ToolChoice,
  options: { includeFileSearchTool?: boolean } = {}
): { sdkTools: any[]; sdkToolChoice: any | undefined } {
  let filteredTools = tools;
  let sdkToolChoice = serializeToolChoiceForSDK(toolChoice);

  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'single') {
      filteredTools = tools.filter(t => t.name === toolChoice.name);
    } else if (toolChoice.type === 'required' && Array.isArray(toolChoice.allowed) && toolChoice.allowed.length > 0) {
      filteredTools = tools.filter(t => toolChoice.allowed.includes(t.name));
    }
  }

  if (toolChoice === 'none') {
    filteredTools = [];
    sdkToolChoice = 'none';
  }

  const sdkTools = serializeToolsForSDK(filteredTools);

  if (options.includeFileSearchTool && toolChoice !== 'none') {
    sdkTools.push({ type: 'file_search' });
  }

  return { sdkTools, sdkToolChoice };
}

