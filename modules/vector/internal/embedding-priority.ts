import type { EmbeddingPriorityItem } from '../../kernel/index.js';
import type { PluginRegistry } from '../../kernel/index.js';

function normalizePriority(priority: EmbeddingPriorityItem[]): string {
  return JSON.stringify(priority);
}

/**
 * Resolve an embedding priority list for vector operations that require embeddings.
 *
 * Resolution order:
 * 1) explicit list (spec/config)
 * 2) default from vector store plugin manifest(s)
 * 3) throw with configuration guidance
 */
export async function resolveEmbeddingPriority(
  options: {
    explicit?: EmbeddingPriorityItem[];
    storeIds: string[];
  },
  registry: PluginRegistry
): Promise<EmbeddingPriorityItem[]> {
  const explicit = options.explicit?.filter(Boolean) ?? [];
  if (explicit.length > 0) {
    return explicit;
  }

  const storeIds = options.storeIds.filter(Boolean);
  const defaults: Array<{ storeId: string; priority: EmbeddingPriorityItem[] }> = [];

  for (const storeId of storeIds) {
    const storeConfig = await registry.getVectorStore(storeId);
    const priority = storeConfig.defaultEmbeddingPriority;
    if (priority && priority.length > 0) {
      defaults.push({ storeId, priority });
    }
  }

  if (defaults.length === 0) {
    throw new Error(
      'No embedding priority configured. Provide vectorContext.embeddingPriority or set defaultEmbeddingPriority on the vector store plugin manifest.'
    );
  }

  const unique = new Map<string, { storeId: string; priority: EmbeddingPriorityItem[] }>();
  for (const entry of defaults) {
    unique.set(normalizePriority(entry.priority), entry);
  }

  if (unique.size === 1) {
    return defaults[0].priority;
  }

  const storeList = Array.from(unique.values())
    .map(v => v.storeId)
    .sort()
    .join(', ');

  throw new Error(
    `Multiple vector stores specify different default embedding priorities (${storeList}). Provide vectorContext.embeddingPriority explicitly.`
  );
}
