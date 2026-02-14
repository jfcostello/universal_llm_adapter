import type {
  VectorContextConfig,
  VectorStorePriorityAttempt
} from '../../../../kernel/index.js';

export interface ResolvedStorePriorityChain {
  fallbackOnEmpty: boolean;
  attempts: VectorStorePriorityAttempt[];
}

function createStorePriorityConfigError(message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = 400;
  (error as any).code = 'config_error';
  return error;
}

export function resolveStorePriorityChain(
  config: VectorContextConfig,
  logicalStoreId: string
): ResolvedStorePriorityChain {
  const explicitConfig = config.storePriority?.[logicalStoreId];
  if (!explicitConfig) {
    return {
      fallbackOnEmpty: false,
      attempts: [{ store: logicalStoreId }]
    };
  }

  if (!Array.isArray(explicitConfig.attempts) || explicitConfig.attempts.length < 1) {
    throw createStorePriorityConfigError(
      `Invalid storePriority configuration for store '${logicalStoreId}': attempts must contain at least one item.`
    );
  }

  const attempts = explicitConfig.attempts.map((attempt, index) => {
    const store = String((attempt as any)?.store ?? '').trim();
    if (!store) {
      throw createStorePriorityConfigError(
        `Invalid storePriority configuration for store '${logicalStoreId}': attempts[${index}].store is required.`
      );
    }

    return {
      store,
      collection: attempt.collection,
      embeddingPriority: attempt.embeddingPriority
    } satisfies VectorStorePriorityAttempt;
  });

  return {
    fallbackOnEmpty: explicitConfig.fallbackOnEmpty === true,
    attempts
  };
}

export function isCompleteVectorQueryResponse(response: unknown): response is unknown[] {
  return Array.isArray(response);
}
