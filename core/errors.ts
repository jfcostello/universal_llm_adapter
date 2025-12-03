export class LLMAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
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