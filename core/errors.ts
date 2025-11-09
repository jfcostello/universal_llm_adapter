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