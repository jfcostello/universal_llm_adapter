import { PluginRegistry } from '../../core/registry.js';
import { LLMCallSpec, UnifiedTool } from '../../core/types.js';
import { MCPManager } from '../../managers/mcp-manager.js';
import { VectorStoreManager } from '../../managers/vector-store-manager.js';
import { sanitizeToolName } from './tool-names.js';

export interface ToolDiscoveryOptions {
  spec: LLMCallSpec;
  registry: PluginRegistry;
  mcpManager?: MCPManager;
  vectorManager?: VectorStoreManager;
  sanitizeName?: (name: string) => string;
}

export interface ToolDiscoveryResult {
  tools: UnifiedTool[];
  mcpServers: string[];
  toolNameMap: Record<string, string>;
}

export async function collectTools({
  spec,
  registry,
  mcpManager,
  vectorManager,
  sanitizeName
}: ToolDiscoveryOptions): Promise<ToolDiscoveryResult> {
  const toolMap = new Map<string, UnifiedTool>();

  for (const tool of spec.tools ?? []) {
    toolMap.set(tool.name, tool);
  }

  for (const reference of spec.functionToolNames ?? []) {
    const tool = await registry.getTool(reference);
    toolMap.set(tool.name, tool);
  }

  let mcpServers: string[] = [];
  if (mcpManager) {
    const [mcpTools, servers] = await mcpManager.gatherTools(spec.mcpServers);
    mcpServers = servers;

    for (const tool of mcpTools) {
      toolMap.set(tool.name, tool);
    }
  }

  if (vectorManager && Array.isArray(spec.vectorPriority) && spec.vectorPriority.length > 0) {
    const vectorQuery = resolveVectorQuery(spec);
    if (vectorQuery) {
      try {
        const { results } = await vectorManager.queryWithPriority(spec.vectorPriority, vectorQuery);
        for (const result of results) {
          const tool = normalizeVectorResult(result);
          if (tool) {
            toolMap.set(tool.name, tool);
          }
        }
      } catch (error) {
        // Swallow vector lookup errors - tool discovery should continue with other sources
        // eslint-disable-next-line no-console
        /* istanbul ignore next */
        console.warn('Vector tool discovery failed', { error: (error as Error).message });
      }
    }
  }

  const sanitize = sanitizeName ?? sanitizeToolName;
  const sanitizedTools: UnifiedTool[] = [];
  const toolNameMap: Record<string, string> = {};

  for (const originalTool of toolMap.values()) {
    const sanitizedName = sanitize(originalTool.name);
    toolNameMap[sanitizedName] = originalTool.name;
    sanitizedTools.push({
      name: sanitizedName,
      description: originalTool.description,
      parametersJsonSchema: originalTool.parametersJsonSchema
    });
  }

  return {
    tools: sanitizedTools,
    mcpServers,
    toolNameMap
  };
}

function resolveVectorQuery(spec: LLMCallSpec): string | undefined {
  if (typeof spec.metadata?.vectorQuery === 'string') {
    return spec.metadata.vectorQuery;
  }

  // Use the most recent user message text as query fallback
  const reversed = [...(spec.messages ?? [])].reverse();
  for (const message of reversed) {
    if (message.role === 'user') {
      const textPart = message.content?.find(part => part.type === 'text' && typeof (part as any).text === 'string') as
        | { type: 'text'; text: string }
        | undefined;
      if (textPart?.text) {
        return textPart.text;
      }
    }
  }

  return undefined;
}

/* istanbul ignore next */
function normalizeVectorResult(result: unknown): UnifiedTool | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const candidate = (result as Record<string, unknown>).tool ?? result;
  return isUnifiedTool(candidate) ? candidate : undefined;
}

function isUnifiedTool(value: unknown): value is UnifiedTool {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    (record.parametersJsonSchema === undefined || typeof record.parametersJsonSchema === 'object')
  );
}
