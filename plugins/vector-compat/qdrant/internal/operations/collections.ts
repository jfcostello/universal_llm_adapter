import type { QdrantClient } from '@qdrant/js-client-rest';
import type { IVectorOperationLogger, JsonObject } from '../../../../../modules/kernel/index.js';
import { VectorStoreError } from '../../../../../modules/kernel/index.js';

export async function createPayloadIndexQdrant(options: {
  client: QdrantClient;
  storeId: string;
  collection: string;
  field: string;
  schema: any;
  logger?: IVectorOperationLogger;
}): Promise<void> {
  const startTime = Date.now();

  options.logger?.logVectorRequest({
    operation: 'createPayloadIndex',
    store: options.storeId,
    collection: options.collection,
    params: { field: options.field, schema: options.schema }
  });

  try {
    await options.client.createPayloadIndex(options.collection, {
      field_name: options.field,
      field_schema: options.schema
    });

    options.logger?.logVectorResponse({
      operation: 'createPayloadIndex',
      store: options.storeId,
      collection: options.collection,
      result: 'success',
      duration: Date.now() - startTime
    });
  } catch (error: any) {
    options.logger?.logVectorResponse({
      operation: 'createPayloadIndex',
      store: options.storeId,
      collection: options.collection,
      result: { error: error.message },
      duration: Date.now() - startTime
    });

    throw new VectorStoreError(`Create payload index failed: ${error.message}`, options.storeId, options.collection);
  }
}

export async function collectionExistsQdrant(options: {
  client: QdrantClient;
  storeId: string;
  collection: string;
}): Promise<boolean> {
  try {
    const { collections } = await options.client.getCollections();
    return collections.some(c => (c as any).name === options.collection);
  } catch (error: any) {
    throw new VectorStoreError(
      `Failed to check collection existence: ${error.message}`,
      options.storeId,
      options.collection
    );
  }
}

export async function createCollectionQdrant(options: {
  client: QdrantClient;
  storeId: string;
  collection: string;
  dimensions: number;
  createOptions?: JsonObject;
  logger?: IVectorOperationLogger;
}): Promise<void> {
  const startTime = Date.now();
  const createOptions = options.createOptions;
  const distance =
    ((createOptions as any)?.distance as 'Cosine' | 'Euclid' | 'Dot' | 'Manhattan') || 'Cosine';
  const payloadIndexes = (createOptions as any)?.payloadIndexes as
    | Array<{ field: string; type: 'keyword' | 'integer' | 'float' | 'boolean' }>
    | undefined;

  // Log createCollection request
  options.logger?.logVectorRequest({
    operation: 'createCollection',
    store: options.storeId,
    collection: options.collection,
    params: { dimensions: options.dimensions, distance, payloadIndexes: payloadIndexes?.length ?? 0 }
  });

  try {
    await options.client.createCollection(options.collection, {
      vectors: {
        size: options.dimensions,
        distance
      }
    });

    if (payloadIndexes?.length) {
      for (const idx of payloadIndexes) {
        const schema =
          idx.type === 'boolean'
            ? 'bool'
            : (idx.type as 'keyword' | 'integer' | 'float' | 'bool');
        await options.client.createPayloadIndex(options.collection, {
          field_name: idx.field,
          field_schema: schema
        });
      }
    }

    // Log success
    options.logger?.logVectorResponse({
      operation: 'createCollection',
      store: options.storeId,
      collection: options.collection,
      result: { success: true, dimensions: options.dimensions, distance, indexes: payloadIndexes?.length ?? 0 },
      duration: Date.now() - startTime
    });
  } catch (error: any) {
    // Log failure
    options.logger?.logVectorResponse({
      operation: 'createCollection',
      store: options.storeId,
      collection: options.collection,
      result: { error: error.message },
      duration: Date.now() - startTime
    });

    throw new VectorStoreError(
      `Failed to create collection: ${error.message}`,
      options.storeId,
      options.collection
    );
  }
}

export async function listCollectionsQdrant(options: {
  client: QdrantClient;
}): Promise<string[]> {
  const res = await options.client.getCollections();
  return (res as any).collections?.map((c: any) => c.name) ?? [];
}

export async function deleteCollectionQdrant(options: {
  client: QdrantClient;
  collection: string;
}): Promise<void> {
  await options.client.deleteCollection(options.collection);
}

