import type { PluginRegistry } from '../../../../../kernel/index.js';

export interface VectorRuntimeState {
  embeddingManager?: any;
  vectorManager?: any;
}

export async function ensureVectorRuntime(state: VectorRuntimeState, registry: PluginRegistry): Promise<VectorRuntimeState> {
  if (!state.embeddingManager) {
    const { EmbeddingManager } = await import('../../../../embeddings/index.js');
    if (typeof EmbeddingManager === 'function') {
      state.embeddingManager = new EmbeddingManager(registry as any);
    }
  }

  if (!state.vectorManager) {
    const { VectorStoreManager } = await import('../../../../vector/index.js');
    if (typeof VectorStoreManager === 'function') {
      state.vectorManager = new VectorStoreManager(
        new Map(),
        new Map(),
        undefined,
        registry
      );
    }
  }

  return state;
}

export async function closeVectorRuntime(state: VectorRuntimeState): Promise<void> {
  if (state.vectorManager?.closeAll) {
    await state.vectorManager.closeAll().catch(() => {});
  }
}
