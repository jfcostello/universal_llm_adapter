import type { QdrantClient } from '@qdrant/js-client-rest';
import type { IVectorOperationLogger } from '../../../../../modules/kernel/index.js';
import { VectorStoreError } from '../../../../../modules/kernel/index.js';
import { normalizePointId } from '../ids/normalize-point-id.js';

export async function deleteByIdsQdrant(options: {
  client: QdrantClient;
  storeId: string;
  collection: string;
  ids: string[];
  logger?: IVectorOperationLogger;
}): Promise<void> {
  const startTime = Date.now();

  // Log delete request
  options.logger?.logVectorRequest({
    operation: 'delete',
    store: options.storeId,
    collection: options.collection,
    params: { idCount: options.ids.length, ids: options.ids }
  });

  try {
    const qdrantIds = options.ids.map(id => normalizePointId(id).qdrantId);
    await options.client.delete(options.collection, {
      wait: true,
      points: qdrantIds
    });

    // Log success
    options.logger?.logVectorResponse({
      operation: 'delete',
      store: options.storeId,
      collection: options.collection,
      result: { success: true, deletedCount: options.ids.length },
      duration: Date.now() - startTime
    });
  } catch (error: any) {
    // Log failure
    options.logger?.logVectorResponse({
      operation: 'delete',
      store: options.storeId,
      collection: options.collection,
      result: { error: error.message },
      duration: Date.now() - startTime
    });

    throw new VectorStoreError(`Delete failed: ${error.message}`, options.storeId, options.collection);
  }
}

