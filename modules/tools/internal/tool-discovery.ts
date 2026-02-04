import { PluginRegistry } from '../../../kernel/index.js';
import { LLMCallSpec, UnifiedTool, VectorContextConfig, ToolSchemaParamOverride } from '../../../kernel/index.js';
import type { MCPManager } from '../../mcp/index.js';
import type { VectorStoreManager } from '../../vector/index.js';
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
  /** Maps exposed vector search param names -> canonical names for arg translation */
  vectorSearchAliasMap?: Record<string, string>;
}
const DISALLOWED_TERMINAL_FLAG_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeToolCallTerminalFlag(
  raw: UnifiedTool['toolCallTerminalFlag']
): UnifiedTool['toolCallTerminalFlag'] | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const field = typeof raw.field === 'string' ? raw.field.trim() : '';
  if (!field) {
    return undefined;
  }
  if (DISALLOWED_TERMINAL_FLAG_FIELDS.has(field)) {
    return undefined;
  }

  const normalized: any = { field };
  if (raw.required === true) {
    normalized.required = true;
  }
  if (typeof raw.description === 'string') {
    const trimmed = raw.description.trim();
    if (trimmed) {
      normalized.description = trimmed;
    }
  }

  return normalized;
}

function isStrictBooleanSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (value as any).type === 'boolean';
}

function applyToolCallTerminalFlagToSchema(
  schema: UnifiedTool['parametersJsonSchema'],
  flag: UnifiedTool['toolCallTerminalFlag'] | undefined
): { schema: UnifiedTool['parametersJsonSchema']; flag: UnifiedTool['toolCallTerminalFlag'] | undefined } {
  if (!flag) {
    return { schema, flag };
  }

  const base = schema && typeof schema === 'object' ? (schema as Record<string, any>) : {};

  const baseProps = base.properties && typeof base.properties === 'object' && !Array.isArray(base.properties)
    ? (base.properties as Record<string, any>)
    : {};

  if (Object.prototype.hasOwnProperty.call(baseProps, flag.field) && !isStrictBooleanSchema(baseProps[flag.field])) {
    // If the tool schema already uses this key for a non-boolean argument, treat the config as invalid.
    // Otherwise we'd strip an argument the tool might rely on (and we'd be silently overriding schema).
    // eslint-disable-next-line no-console
    console.warn('tool_call_terminal_flag.schema_collision', {
      field: flag.field
    });
    return { schema, flag: undefined };
  }

  const next: Record<string, any> = { ...base };

  // Default to object type if unset; don't overwrite if explicitly set to something else.
  if (next.type === undefined) {
    next.type = 'object';
  }

  next.properties = {
    ...baseProps,
    ...(Object.prototype.hasOwnProperty.call(baseProps, flag.field)
      ? {}
      : {
          [flag.field]: {
            type: 'boolean',
            ...(flag.description ? { description: flag.description } : {})
          }
        })
  };

  if (flag.required === true) {
    const required = Array.isArray(base.required) ? [...base.required] : [];
    if (!required.includes(flag.field)) {
      required.push(flag.field);
    }
    next.required = required;
  }

  return { schema: next as any, flag };
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
        console.warn('Vector tool discovery failed', { error: (error as Error).message });
      }
    }
  }

  // Create vector_search tool if vectorContext mode is 'tool' or 'both'
  let vectorSearchAliasMap: Record<string, string> | undefined;
  if (spec.vectorContext && shouldCreateVectorSearchTool(spec.vectorContext.mode)) {
    const result = createVectorSearchTool(spec.vectorContext);
    toolMap.set(result.tool.name, result.tool);
    vectorSearchAliasMap = result.aliasMap;
  }

  const sanitize = sanitizeName ?? sanitizeToolName;
  const sanitizedTools: UnifiedTool[] = [];
  const toolNameMap: Record<string, string> = {};

  for (const originalTool of toolMap.values()) {
    const sanitizedName = sanitize(originalTool.name);
    toolNameMap[sanitizedName] = originalTool.name;
    const terminalFlag = normalizeToolCallTerminalFlag(originalTool.toolCallTerminalFlag);
    const appliedFlag = applyToolCallTerminalFlagToSchema(originalTool.parametersJsonSchema, terminalFlag);
    sanitizedTools.push({
      name: sanitizedName,
      id: originalTool.id,
      description: originalTool.description,
      parametersJsonSchema: appliedFlag.schema,
      toolCallTerminalFlag: appliedFlag.flag,
      terminal: originalTool.terminal,
      processRouteId: originalTool.processRouteId
    });
  }

  return {
    tools: sanitizedTools,
    mcpServers,
    toolNameMap,
    vectorSearchAliasMap
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

/**
 * Check if a vector_search tool should be created based on vectorContext mode.
 */
export function shouldCreateVectorSearchTool(mode: string | undefined): boolean {
  return mode === 'tool' || mode === 'both';
}

/**
 * Result from creating a vector search tool, including the alias map for arg translation.
 */
export interface VectorSearchToolResult {
  /** The generated tool definition */
  tool: UnifiedTool;
  /** Maps exposed parameter name -> canonical name for arg translation */
  aliasMap: Record<string, string>;
}

/**
 * Default parameter configurations for vector search tool.
 */
interface ParamConfig {
  canonical: string;
  type: string;
  defaultDescription: (config: VectorContextConfig) => string;
  /** Whether this param is exposed by default (without overrides) */
  defaultExpose: boolean;
  /** Property for lock check - if locked, param is always hidden */
  lockKey?: keyof NonNullable<VectorContextConfig['locks']>;
  /** Additional properties for the schema */
  additionalProps?: Record<string, any>;
}

const PARAM_CONFIGS: ParamConfig[] = [
  {
    canonical: 'query',
    type: 'string',
    defaultDescription: () => 'The search query to find relevant context',
    defaultExpose: true
    // query is never locked
  },
  {
    canonical: 'topK',
    type: 'number',
    defaultDescription: (config) => `Number of results to return (default: ${config.topK ?? 5})`,
    defaultExpose: true,
    lockKey: 'topK'
  },
  {
    canonical: 'store',
    type: 'string',
    defaultDescription: (config) => `Which store to search (options: ${config.stores.join(', ')})`,
    defaultExpose: true,
    lockKey: 'store'
  },
  {
    canonical: 'filter',
    type: 'object',
    defaultDescription: () => 'Metadata filter to constrain results (JSON object)',
    defaultExpose: true,
    lockKey: 'filter',
    additionalProps: { additionalProperties: true }
  },
  {
    canonical: 'collection',
    type: 'string',
    defaultDescription: (config) => `Collection to search within the store${config.collection ? ` (default: ${config.collection})` : ''}`,
    defaultExpose: false, // Hidden by default
    lockKey: 'collection'
  },
  {
    canonical: 'scoreThreshold',
    type: 'number',
    defaultDescription: (config) => `Minimum similarity score (0-1)${config.scoreThreshold !== undefined ? ` (default: ${config.scoreThreshold})` : ''}`,
    defaultExpose: false, // Hidden by default
    lockKey: 'scoreThreshold'
  }
];

/**
 * Create a vector_search tool for LLM-driven vector store queries.
 * When locks are specified, locked parameters are omitted from the schema
 * and enforced server-side.
 *
 * Supports schema overrides for customizing parameter names and descriptions.
 */
export function createVectorSearchTool(config: VectorContextConfig): VectorSearchToolResult {
  const toolName = config.toolName ?? 'vector_search';
  const locks = config.locks;
  const overrides = config.toolSchemaOverrides;

  // Build description - priority: overrides.toolDescription > config.toolDescription > auto-generated
  let description: string;
  if (overrides?.toolDescription) {
    description = overrides.toolDescription;
  } else if (config.toolDescription) {
    description = config.toolDescription;
  } else if (locks?.store) {
    description = `Search the vector store for relevant information. Searching: ${locks.store}`;
  } else {
    description = `Search the vector store for relevant information. Available stores: ${config.stores.join(', ')}`;
  }

  const properties: Record<string, any> = {};
  const aliasMap: Record<string, string> = {};
  const usedExposedNames = new Set<string>();

  for (const paramConfig of PARAM_CONFIGS) {
    const { canonical, type, defaultDescription, defaultExpose, lockKey, additionalProps } = paramConfig;

    // Check if locked - locked params are always hidden
    if (lockKey && locks?.[lockKey] !== undefined) {
      continue;
    }

    // Get override for this param
    const override: ToolSchemaParamOverride | undefined =
      overrides?.params?.[canonical as keyof NonNullable<typeof overrides.params>];

    // Determine if exposed
    const shouldExpose = override?.expose ?? defaultExpose;
    if (!shouldExpose) {
      continue;
    }

    // Determine exposed name
    const exposedName = override?.name ?? canonical;

    // Check for duplicate exposed names
    if (usedExposedNames.has(exposedName)) {
      throw new Error(
        `Duplicate exposed parameter name '${exposedName}' in toolSchemaOverrides. ` +
        `Each parameter must have a unique exposed name.`
      );
    }
    usedExposedNames.add(exposedName);

    // Determine description
    const paramDescription = override?.description ?? defaultDescription(config);

    // Build property
    properties[exposedName] = {
      type,
      description: paramDescription,
      ...additionalProps
    };

    // Add to alias map
    aliasMap[exposedName] = canonical;
  }

  // Determine required fields - query (or its alias) is always required
  const queryAlias = overrides?.params?.query?.name ?? 'query';
  const required = usedExposedNames.has(queryAlias) ? [queryAlias] : ['query'];

  const tool: UnifiedTool = {
    name: toolName,
    description,
    parametersJsonSchema: {
      type: 'object',
      properties,
      required
    }
  };

  return { tool, aliasMap };
}
