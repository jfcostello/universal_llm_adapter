import type { QdrantClient } from '@qdrant/js-client-rest';
import type { IVectorOperationLogger, VectorPoint } from '../../../../../kernel/index.js';
import { VectorStoreError } from '../../../../../kernel/index.js';
import { normalizePointId, ORIGINAL_ID_KEY } from '../ids/normalize-point-id.js';

export async function upsertQdrant(options: {
  client: QdrantClient;
  storeId: string;
  collection: string;
  points: VectorPoint[];
  logger?: IVectorOperationLogger;
}): Promise<void> {
  const startTime = Date.now();

  // Log upsert request
  options.logger?.logVectorRequest({
    operation: 'upsert',
    store: options.storeId,
    collection: options.collection,
    params: {
      pointCount: options.points.length,
      ids: options.points.map(p => p.id),
      vectorDimensions: options.points[0]?.vector.length
    }
  });

  try {
    const qdrantPoints = options.points.map(point => {
      const normalized = normalizePointId(point.id);
      const payload =
        normalized.originalId !== undefined
          ? { ...(point.payload || {}), [ORIGINAL_ID_KEY]: normalized.originalId }
          : (point.payload || {});
      return { id: normalized.qdrantId, vector: point.vector, payload };
    });

    await options.client.upsert(options.collection, {
      wait: true,
      points: qdrantPoints
    });

    // Log success
    options.logger?.logVectorResponse({
      operation: 'upsert',
      store: options.storeId,
      collection: options.collection,
      result: { success: true, pointCount: options.points.length },
      duration: Date.now() - startTime
    });
  } catch (error: any) {
    // Log failure
    options.logger?.logVectorResponse({
      operation: 'upsert',
      store: options.storeId,
      collection: options.collection,
      result: { error: error.message },
      duration: Date.now() - startTime
    });

    throw new VectorStoreError(`Upsert failed: ${error.message}`, options.storeId, options.collection);
  }
}

