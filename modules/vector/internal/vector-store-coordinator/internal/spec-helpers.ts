import type { PluginRegistry, TextChunk, VectorCallSpec } from '../../../../../kernel/index.js';

export function extractTexts(spec: VectorCallSpec): { texts: string[]; chunks: TextChunk[] } {
  const input = spec.input;
  if (!input) {
    return { texts: [], chunks: [] };
  }

  const chunks: TextChunk[] = [];

  if (input.texts) {
    for (const text of input.texts) {
      chunks.push({ text });
    }
  }

  if (input.chunks) {
    chunks.push(...input.chunks);
  }

  const texts = chunks.map(c => c.text);
  return { texts, chunks };
}

export async function resolveCollection(registry: PluginRegistry, spec: VectorCallSpec): Promise<string> {
  if (spec.collection) {
    return spec.collection;
  }

  const storeConfig = await registry.getVectorStore(spec.store);
  return storeConfig.defaultCollection ?? 'default';
}
