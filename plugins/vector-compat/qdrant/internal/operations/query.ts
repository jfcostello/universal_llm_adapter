import type { QdrantClient } from '@qdrant/js-client-rest';
import type {
  IVectorOperationLogger,
  JsonObject,
  VectorQueryOptions,
  VectorQueryResult
} from '../../../../../kernel/index.js';
import { VectorStoreError } from '../../../../../kernel/index.js';
import { convertFilter } from '../filters/convert-filter.js';
import { ORIGINAL_ID_KEY } from '../ids/normalize-point-id.js';

export async function queryQdrant(options: {
  client: QdrantClient;
  storeId: string;
  collection: string;
  vector: number[];
  topK: number;
  queryOptions?: VectorQueryOptions;
  logger?: IVectorOperationLogger;
}): Promise<VectorQueryResult[]> {
  const startTime = Date.now();
  const queryOptions = options.queryOptions;

  // Log query request
  options.logger?.logVectorRequest({
    operation: 'query',
    store: options.storeId,
    collection: options.collection,
    params: {
      vectorDimensions: options.vector.length,
      topK: options.topK,
      filter: queryOptions?.filter,
      includePayload: queryOptions?.includePayload !== false,
      includeVector: queryOptions?.includeVector || false
    }
  });

  try {
    const searchParams: any = {
      vector: options.vector,
      limit: options.topK,
      with_payload: queryOptions?.includePayload !== false,
      with_vector: queryOptions?.includeVector || false
    };

    // Convert generic filter to Qdrant format
    if (queryOptions?.filter) {
      const qFilter = convertFilter(queryOptions.filter);
      if (qFilter !== undefined) {
        searchParams.filter = qFilter;
      }
    }

    const results = await options.client.search(options.collection, searchParams);

    const mappedResults = results.map(item => ({
      id:
        item.payload && typeof (item.payload as any)[ORIGINAL_ID_KEY] === 'string'
          ? String((item.payload as any)[ORIGINAL_ID_KEY])
          : String(item.id),
      score: item.score,
      payload:
        item.payload && typeof (item.payload as any)[ORIGINAL_ID_KEY] === 'string'
          ? (() => {
              const payload = { ...(item.payload as any) };
              delete (payload as any)[ORIGINAL_ID_KEY];
              return payload as JsonObject;
            })()
          : (item.payload as JsonObject | undefined),
      vector: item.vector as number[] | undefined
    }));

    // Log success
    options.logger?.logVectorResponse({
      operation: 'query',
      store: options.storeId,
      collection: options.collection,
      result: {
        count: mappedResults.length,
        topScore: mappedResults[0]?.score,
        ids: mappedResults.map(r => r.id)
      },
      duration: Date.now() - startTime
    });

    return mappedResults;
  } catch (error: any) {
    // Log failure
    options.logger?.logVectorResponse({
      operation: 'query',
      store: options.storeId,
      collection: options.collection,
      result: { error: error.message },
      duration: Date.now() - startTime
    });

    throw new VectorStoreError(`Query failed: ${error.message}`, options.storeId, options.collection);
  }
}

