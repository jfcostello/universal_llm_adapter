import type { PluginRegistry, VectorCallSpec, VectorOperationResult, VectorStreamEvent } from '../../../../kernel/index.js';
import { resolveLoggingDeps, type LoggingDeps } from '../../../../kernel/index.js';

import { executeCollections, executeDelete, executeQuery, executeUpsert } from './internal/execute-non-embed.js';
import { executeEmbed, executeEmbedStream } from './internal/execute-embed.js';
import { closeVectorManager, ensureEmbeddingManager, ensureVectorManager, type VectorCoordinatorState } from './internal/state.js';

export class VectorStoreCoordinator {
  private state: VectorCoordinatorState;

  constructor(registry: PluginRegistry, options?: { logging?: Partial<LoggingDeps> }) {
    const logging = resolveLoggingDeps(options?.logging);

    this.state = {
      registry,
      embeddingLogger: logging.getEmbeddingLogger(),
      vectorLogger: logging.getVectorLogger()
    };
  }

  async execute(spec: VectorCallSpec): Promise<VectorOperationResult> {
    try {
      switch (spec.operation) {
        case 'embed':
          return await executeEmbed(this.state, spec);
        case 'upsert':
          return await executeUpsert(this.state, spec);
        case 'query':
          return await executeQuery(this.state, spec);
        case 'delete':
          return await executeDelete(this.state, spec);
        case 'collections':
          return await executeCollections(this.state, spec);
        default:
          return {
            operation: (spec as any).operation ?? 'unknown',
            success: false,
            error: `Unknown operation: ${(spec as any).operation}`
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        operation: spec.operation,
        success: false,
        error: message
      };
    }
  }

  async *executeStream(spec: VectorCallSpec): AsyncGenerator<VectorStreamEvent> {
    try {
      if (spec.operation === 'embed' && spec.input) {
        yield* executeEmbedStream(this.state, spec);
        return;
      }

      const result = await this.execute(spec);
      yield { type: 'result', result };
      yield { type: 'done' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }

  async close(): Promise<void> {
    await closeVectorManager(this.state);
  }
}
