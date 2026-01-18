import type { VectorCallSpec, VectorOperationResult, VectorQueryOptions } from '../../../../../kernel/index.js';
import { ensureEmbeddingManager, ensureVectorManager, type VectorCoordinatorState } from './state.js';
import { resolveCollection } from './spec-helpers.js';

export async function executeUpsert(state: VectorCoordinatorState, spec: VectorCallSpec): Promise<VectorOperationResult> {
  if (!spec.input?.points || spec.input.points.length === 0) {
    return { operation: 'upsert', success: true, upserted: 0 };
  }

  const vectorManager = await ensureVectorManager(state);
  const collection = await resolveCollection(state.registry, spec);
  const compat = await vectorManager.getCompat(spec.store);

  if (!compat) {
    throw new Error(`Vector store not found: ${spec.store}`);
  }

  await compat.upsert(collection, spec.input.points);
  return { operation: 'upsert', success: true, upserted: spec.input.points.length };
}

export async function executeQuery(state: VectorCoordinatorState, spec: VectorCallSpec): Promise<VectorOperationResult> {
  const vectorManager = await ensureVectorManager(state);

  const input = spec.input;
  if (!input) {
    return { operation: 'query', success: false, error: 'input is required for query operation' };
  }

  const compat = await vectorManager.getCompat(spec.store);
  if (!compat) {
    throw new Error(`Vector store not found: ${spec.store}`);
  }

  const collection = await resolveCollection(state.registry, spec);
  const topK = input.topK ?? 5;

  let queryVector: number[] | undefined = input.vector;
  if (!queryVector && input.query) {
    if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
      return { operation: 'query', success: false, error: 'embeddingPriority is required when querying with text' };
    }

    const embeddingManager = await ensureEmbeddingManager(state);
    const embedResult = await embeddingManager.embed(input.query, spec.embeddingPriority);
    queryVector = embedResult.vectors[0];
  }

  if (!queryVector) {
    return { operation: 'query', success: false, error: 'Either query or vector must be provided' };
  }

  const options: VectorQueryOptions = {
    filter: input.filter,
    includePayload: spec.settings?.includePayload ?? true,
    includeVector: spec.settings?.includeVector
  };

  let results = await compat.query(collection, queryVector, topK, options);
  if (input.scoreThreshold !== undefined) {
    results = results.filter(r => r.score >= input.scoreThreshold!);
  }

  return { operation: 'query', success: true, results };
}

export async function executeDelete(state: VectorCoordinatorState, spec: VectorCallSpec): Promise<VectorOperationResult> {
  const vectorManager = await ensureVectorManager(state);

  const ids = spec.input?.ids;
  if (!ids || ids.length === 0) {
    return { operation: 'delete', success: true, deleted: 0 };
  }

  const collection = await resolveCollection(state.registry, spec);
  const compat = await vectorManager.getCompat(spec.store);
  if (!compat) {
    throw new Error(`Vector store not found: ${spec.store}`);
  }

  await compat.deleteByIds(collection, ids);
  return { operation: 'delete', success: true, deleted: ids.length };
}

export async function executeCollections(
  state: VectorCoordinatorState,
  spec: VectorCallSpec
): Promise<VectorOperationResult> {
  const vectorManager = await ensureVectorManager(state);
  const compat = await vectorManager.getCompat(spec.store);
  if (!compat) {
    throw new Error(`Vector store not found: ${spec.store}`);
  }

  const op = spec.input?.collectionOp ?? 'list';
  const input = spec.input;

  switch (op) {
    case 'list': {
      if (typeof (compat as any).listCollections === 'function') {
        const collections = await (compat as any).listCollections();
        return { operation: 'collections', success: true, collections };
      }
      return {
        operation: 'collections',
        success: false,
        error: 'listCollections not supported by this store'
      };
    }

    case 'create': {
      if (!input?.collectionName) {
        return { operation: 'collections', success: false, error: 'collectionName is required for create' };
      }
      if (!input.dimensions) {
        return { operation: 'collections', success: false, error: 'dimensions is required for create' };
      }
      if (typeof (compat as any).createCollection === 'function') {
        await (compat as any).createCollection(input.collectionName, input.dimensions, {
          payloadIndexes: input.payloadIndexes ?? []
        });
        return { operation: 'collections', success: true, created: true };
      }
      return {
        operation: 'collections',
        success: false,
        error: 'createCollection not supported by this store'
      };
    }

    case 'delete': {
      if (!input?.collectionName) {
        return { operation: 'collections', success: false, error: 'collectionName is required for delete' };
      }
      if (typeof (compat as any).deleteCollection === 'function') {
        await (compat as any).deleteCollection(input.collectionName);
        return { operation: 'collections', success: true };
      }
      return {
        operation: 'collections',
        success: false,
        error: 'deleteCollection not supported by this store'
      };
    }

    case 'exists': {
      if (!input?.collectionName) {
        return { operation: 'collections', success: false, error: 'collectionName is required for exists' };
      }
      const exists = await compat.collectionExists(input.collectionName);
      return { operation: 'collections', success: true, exists };
    }

    default:
      return { operation: 'collections', success: false, error: `Unknown collection operation: ${op}` };
  }
}
