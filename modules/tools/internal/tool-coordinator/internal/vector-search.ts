import type { VectorContextConfig } from '../../../../../kernel/index.js';

export interface VectorSearchEntry {
  config: VectorContextConfig;
  aliasMap?: Record<string, string>;
}

export function computeVectorSearchState(
  configs: VectorContextConfig[] | undefined,
  aliasMaps?: Record<string, Record<string, string>>
): Map<string, VectorSearchEntry> {
  const byToolName = new Map<string, VectorSearchEntry>();

  if (!configs || configs.length < 1) {
    return byToolName;
  }

  for (const cfg of configs) {
    if (!cfg || typeof cfg !== 'object') {
      continue;
    }
    const toolName = cfg.toolName ?? 'vector_search';
    byToolName.set(toolName, { config: cfg, aliasMap: aliasMaps?.[toolName] });
  }

  return byToolName;
}

export function getVectorSearchEntryForToolName(options: {
  toolName: string;
  byToolName: Map<string, VectorSearchEntry>;
}): VectorSearchEntry | undefined {
  const toolName = options.toolName;

  const entry = options.byToolName.get(toolName);
  if (!entry) {
    return undefined;
  }

  const mode = entry.config.mode;
  if (mode !== 'tool' && mode !== 'both') {
    return undefined;
  }

  return entry;
}

export function translateVectorSearchArgs(args: Record<string, any>, aliasMap?: Record<string, string>): Record<string, any> {
  if (!aliasMap) {
    return args;
  }

  const translated: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    const canonicalName = aliasMap[key] ?? key;
    translated[canonicalName] = value;
  }
  return translated;
}
