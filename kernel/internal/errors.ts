const LLM_ADAPTER_ERROR_CHAIN = Symbol.for('llm_adapter_error_chain');

function getConstructorNameChain(value: object): string[] {
  const names: string[] = [];
  let proto: any = Object.getPrototypeOf(value);

  while (proto && typeof proto === 'object') {
    const ctor = proto.constructor;
    const name = typeof ctor?.name === 'string' ? ctor.name : '';
    if (name) {
      names.push(name);
    }
    proto = Object.getPrototypeOf(proto);
  }

  return names;
}

export class LLMAdapterError extends Error {
  static [Symbol.hasInstance](instance: unknown): boolean {
    if (!instance || typeof instance !== 'object') return false;

    const existingChain = (instance as any)[LLM_ADAPTER_ERROR_CHAIN];
    const chain = Array.isArray(existingChain) ? existingChain : getConstructorNameChain(instance as object);
    return chain.includes(this.name);
  }

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;

    try {
      Object.defineProperty(this, LLM_ADAPTER_ERROR_CHAIN, {
        value: getConstructorNameChain(this),
        enumerable: false
      });
    } catch {
      // Best-effort: some error objects may be non-extensible in exotic environments.
    }
  }
}

export class ManifestError extends LLMAdapterError {}

export class ProviderExecutionError extends LLMAdapterError {
  constructor(
    public provider: string,
    message: string,
    public statusCode?: number,
    public isRateLimit = false
  ) {
    super(`[${provider}] ${message}`);
  }
}

export class ToolExecutionError extends LLMAdapterError {}

export class MCPConnectionError extends LLMAdapterError {}

export class ProviderPayloadError extends LLMAdapterError {}

// ============================================================
// VECTOR STORE ERRORS
// ============================================================

export class VectorStoreError extends LLMAdapterError {
  constructor(
    message: string,
    public storeId?: string,
    public collection?: string
  ) {
    super(message);
  }
}

export class VectorStoreConnectionError extends VectorStoreError {
  constructor(storeId: string, message: string) {
    super(`Failed to connect to vector store '${storeId}': ${message}`, storeId);
  }
}

// ============================================================
// EMBEDDING ERRORS
// ============================================================

export class EmbeddingError extends LLMAdapterError {
  constructor(
    message: string,
    public provider?: string,
    public model?: string
  ) {
    super(message);
  }
}

export class EmbeddingProviderError extends EmbeddingError {
  constructor(
    provider: string,
    message: string,
    public statusCode?: number,
    public isRateLimit = false
  ) {
    super(`[${provider}] ${message}`, provider);
  }
}
