import { randomUUID } from 'crypto';

import type { LLMCallSpec, ObservabilityContext } from '../../../kernel/index.js';
import { normalizeParentGenerationId, readRequestedGenerationId, readRequestedParentGenerationId } from '../../shared/index.js';

export function resolveStreamGenerationContext(options: {
  observability?: ObservabilityContext;
  observabilitySpec?: LLMCallSpec['observability'];
  metadata?: Record<string, any>;
}): { generationId: string | undefined; parentGenerationId: string | undefined } {
  if (!options.observability) {
    return { generationId: undefined, parentGenerationId: undefined };
  }

  const generationId = readRequestedGenerationId(options.metadata) ?? randomUUID();
  const requestedParentGenerationId = readRequestedParentGenerationId(options.observabilitySpec, options.metadata);
  const parentGenerationId = normalizeParentGenerationId(requestedParentGenerationId, generationId);

  return { generationId, parentGenerationId };
}
