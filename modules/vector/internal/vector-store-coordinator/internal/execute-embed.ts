import { randomUUID } from 'crypto';

import type { VectorPoint, VectorCallSpec, VectorOperationResult, VectorStreamEvent } from '../../../../../kernel/index.js';
import { ensureEmbeddingManager, ensureVectorManager, type VectorCoordinatorState } from './state.js';
import { extractTexts, resolveCollection } from './spec-helpers.js';

export async function executeEmbed(state: VectorCoordinatorState, spec: VectorCallSpec): Promise<VectorOperationResult> {
  const batchSize = spec.settings?.batchSize ?? 10;

  if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
    return {
      operation: 'embed',
      success: false,
      error: 'embeddingPriority is required for embed operation'
    };
  }

  const { texts, chunks } = extractTexts(spec);
  if (texts.length === 0) {
    return {
      operation: 'embed',
      success: true,
      embedded: 0,
      upserted: 0
    };
  }

  const vectorManager = await ensureVectorManager(state);
  const embeddingManager = await ensureEmbeddingManager(state);
  const collection = await resolveCollection(state.registry, spec);

  const compat = await vectorManager.getCompat(spec.store);
  if (!compat) {
    throw new Error(`Vector store not found: ${spec.store}`);
  }

  let embedded = 0;
  const points: VectorPoint[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, texts.length);
    const batchTexts = texts.slice(i, batchEnd);
    const batchChunks = chunks.slice(i, batchEnd);

    const result = await embeddingManager.embed(batchTexts, spec.embeddingPriority);
    const vectors = result.vectors;

    for (let j = 0; j < vectors.length; j++) {
      const chunk = batchChunks[j];
      points.push({
        id: chunk.id || randomUUID(),
        vector: vectors[j],
        payload: {
          text: chunk.text,
          ...chunk.metadata
        }
      });
    }

    embedded += vectors.length;
  }

  await compat.upsert(collection, points);

  return {
    operation: 'embed',
    success: true,
    embedded,
    upserted: points.length,
    dimensions: points[0]?.vector.length
  };
}

export async function* executeEmbedStream(
  state: VectorCoordinatorState,
  spec: VectorCallSpec
): AsyncGenerator<VectorStreamEvent> {
  const batchSize = spec.settings?.batchSize ?? 10;

  if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
    yield { type: 'error', error: 'embeddingPriority is required for embed operation' };
    return;
  }

  const { texts, chunks } = extractTexts(spec);
  if (texts.length === 0) {
    yield { type: 'result', result: { operation: 'embed', success: true, embedded: 0, upserted: 0 } };
    yield { type: 'done' };
    return;
  }

  const vectorManager = await ensureVectorManager(state);
  const embeddingManager = await ensureEmbeddingManager(state);
  const collection = await resolveCollection(state.registry, spec);

  const compat = await vectorManager.getCompat(spec.store);
  if (!compat) {
    yield { type: 'error', error: `Vector store not found: ${spec.store}` };
    return;
  }

  let embedded = 0;
  const points: VectorPoint[] = [];
  const totalBatches = Math.ceil(texts.length / batchSize);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, texts.length);
    const batchTexts = texts.slice(i, batchEnd);
    const batchChunks = chunks.slice(i, batchEnd);
    const batchNumber = Math.floor(i / batchSize) + 1;

    yield {
      type: 'progress',
      progress: {
        current: batchNumber,
        total: totalBatches,
        message: `Embedding batch ${batchNumber}`
      }
    };

    const result = await embeddingManager.embed(batchTexts, spec.embeddingPriority);
    const vectors = result.vectors;

    for (let j = 0; j < vectors.length; j++) {
      const chunk = batchChunks[j];
      points.push({
        id: chunk.id || randomUUID(),
        vector: vectors[j],
        payload: {
          text: chunk.text,
          ...chunk.metadata
        }
      });
    }

    embedded += vectors.length;
  }

  yield {
    type: 'progress',
    progress: {
      current: totalBatches,
      total: totalBatches,
      message: 'Upserting points'
    }
  };

  await compat.upsert(collection, points);

  yield {
    type: 'result',
    result: {
      operation: 'embed',
      success: true,
      embedded,
      upserted: points.length,
      dimensions: points[0]?.vector.length
    }
  };
  yield { type: 'done' };
}
