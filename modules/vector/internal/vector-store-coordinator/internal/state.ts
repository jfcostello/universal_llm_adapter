import type { PluginRegistry } from '../../../../../kernel/index.js';
import type { IEmbeddingOperationLogger, IVectorOperationLogger } from '../../../../../kernel/index.js';
import type { EmbeddingManager } from '../../../../embeddings/index.js';

import { VectorStoreManager } from '../../vector-store-manager.js';

export interface VectorCoordinatorState {
  registry: PluginRegistry;
  embeddingManager?: EmbeddingManager;
  vectorManager?: VectorStoreManager;
  embeddingLogger: IEmbeddingOperationLogger;
  vectorLogger: IVectorOperationLogger;
}

export async function ensureEmbeddingManager(state: VectorCoordinatorState): Promise<EmbeddingManager> {
  if (!state.embeddingManager) {
    const { EmbeddingManager } = await import('../../../../embeddings/index.js');
    state.embeddingManager = new EmbeddingManager(state.registry as any, state.embeddingLogger);
  }
  return state.embeddingManager;
}

export async function ensureVectorManager(state: VectorCoordinatorState): Promise<VectorStoreManager> {
  if (!state.vectorManager) {
    state.vectorManager = new VectorStoreManager(
      new Map(),
      new Map(),
      undefined,
      state.registry,
      state.vectorLogger
    );
  }
  return state.vectorManager;
}

export async function closeVectorManager(state: VectorCoordinatorState): Promise<void> {
  await state.vectorManager?.closeAll();
}
