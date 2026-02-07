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

function createAbortError(message: string): Error {
  const error = new Error(message);
  (error as any).name = 'AbortError';
  (error as any).code = 'aborted';
  return error;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = String((error as any).name ?? '');
  const code = String((error as any).code ?? '');

  if (['AbortError', 'CanceledError'].includes(name)) return true;
  return ['aborted', 'ABORT_ERR', 'ERR_CANCELED'].includes(code);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError('Vector query aborted');
  }
}

async function runWithTimeout<T>(operation: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation();
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(createAbortError(`Vector query timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  throwIfAborted(queryOptions?.signal);

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

    if (typeof queryOptions?.timeoutMs === 'number' && Number.isFinite(queryOptions.timeoutMs) && queryOptions.timeoutMs > 0) {
      // Qdrant timeout granularity is seconds. Floor avoids extending larger budgets.
      searchParams.timeout = Math.max(1, Math.floor(queryOptions.timeoutMs / 1000));
    }

    // Convert generic filter to Qdrant format
    if (queryOptions?.filter) {
      const qFilter = convertFilter(queryOptions.filter);
      if (qFilter !== undefined) {
        searchParams.filter = qFilter;
      }
    }

    const results = await runWithTimeout(
      () => options.client.search(options.collection, searchParams),
      queryOptions?.timeoutMs
    );
    throwIfAborted(queryOptions?.signal);

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

    if (isAbortLikeError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new VectorStoreError(`Query failed: ${message}`, options.storeId, options.collection);
  }
}
