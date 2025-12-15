import {
  ProviderExecutionError,
  ToolExecutionError,
  MCPConnectionError,
  VectorStoreError,
  EmbeddingProviderError
} from '../../../kernel/index.js';

function normalizeCode(status: number, error: any): string {
  const explicitCode = error?.code;
  if (explicitCode && !(status === 503 && explicitCode === 'queue_timeout')) return String(explicitCode);

  if (status === 400) {
    if (String(error?.message ?? '').toLowerCase().includes('validation')) return 'validation_error';
    if (String(error?.message ?? '').toLowerCase().includes('json')) return 'invalid_json';
    return 'bad_request';
  }
  if (status === 413) return 'payload_too_large';
  if (status === 415) return 'unsupported_media_type';
  if (status === 408) return 'body_read_timeout';
  if (status === 429) return 'rate_limited';
  if (status === 503) return explicitCode === 'queue_timeout' ? 'queue_timeout' : 'server_busy';
  if (status === 504) return 'timeout';

  return 'internal';
}

export function mapErrorToHttp(error: any): { status: number; body: any } {
  let status = Number(error?.statusCode) || 500;

  // Normalize domain errors to stable HTTP codes
  if (error instanceof ProviderExecutionError || error instanceof EmbeddingProviderError) {
    if (error.isRateLimit) {
      status = 429;
    } else {
      status = 502;
    }
  } else if (error instanceof ToolExecutionError || error instanceof MCPConnectionError || error instanceof VectorStoreError) {
    status = 502;
  }

  const message = error?.message ?? 'Server error';
  const code = normalizeCode(status, error);
  const details = error?.details;

  return {
    status,
    body: {
      type: 'error',
      error: {
        message,
        code,
        ...(details ? { details } : {})
      }
    }
  };
}
