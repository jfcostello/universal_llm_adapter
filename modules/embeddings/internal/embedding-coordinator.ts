import type { PluginRegistry, EmbeddingCallSpec, EmbeddingOperationResult } from '../../kernel/index.js';
import { getEmbeddingLogger } from '../../logging/index.js';
import { EmbeddingManager } from './embedding-manager.js';

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class EmbeddingCoordinator {
  private manager: EmbeddingManager;

  constructor(private registry: PluginRegistry) {
    this.manager = new EmbeddingManager(registry, getEmbeddingLogger());
  }

  async execute(spec: EmbeddingCallSpec): Promise<EmbeddingOperationResult> {
    const operation = (spec as any)?.operation ?? 'unknown';

    const correlationId = spec?.metadata?.correlationId as string | undefined;
    this.manager.setLogger(getEmbeddingLogger(correlationId));

    try {
      if (operation === 'embed') {
        if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
          return {
            operation,
            success: false,
            error: 'embeddingPriority is required for embed operation'
          };
        }

        const inputText =
          typeof spec.input?.text === 'string' ? spec.input.text : undefined;
        const inputTexts = spec.input?.texts;

        if (inputText === undefined && (!Array.isArray(inputTexts) || inputTexts.length === 0)) {
          return {
            operation,
            success: false,
            error: 'input.text or input.texts is required for embed operation'
          };
        }

        const embedInput = inputText ?? (inputTexts as string[]);
        const result = await this.manager.embed(embedInput, spec.embeddingPriority);

        return { operation: 'embed', success: true, ...result };
      }

      if (operation === 'dimensions') {
        const provider = spec.provider;
        if (!provider) {
          return { operation, success: false, error: 'provider is required for dimensions operation' };
        }
        const dimensions = await this.manager.getDimensions(provider, spec.model);
        return { operation, success: true, dimensions };
      }

      if (operation === 'validate') {
        const provider = spec.provider;
        if (!provider) {
          return { operation, success: false, error: 'provider is required for validate operation' };
        }
        const valid = await this.manager.validate(provider);
        return { operation, success: true, valid };
      }

      return { operation, success: false, error: `Unknown operation: ${operation}` };
    } catch (error) {
      return { operation, success: false, error: asErrorMessage(error) };
    }
  }

  async close(): Promise<void> {
    // No-op for now. Kept for lifecycle symmetry with other coordinators.
  }
}

