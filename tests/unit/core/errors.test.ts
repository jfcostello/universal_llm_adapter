import {
  LLMAdapterError,
  ManifestError,
  ProviderExecutionError,
  ToolExecutionError,
  MCPConnectionError,
  ProviderPayloadError
} from '@/core/errors.ts';

describe('core/errors', () => {
  test('ProviderExecutionError extends base error with metadata', () => {
    const error = new ProviderExecutionError('provider-a', 'failure', 503, true);
    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toBeInstanceOf(LLMAdapterError);
    expect(error.message).toContain('[provider-a] failure');
    expect(error.statusCode).toBe(503);
    expect(error.isRateLimit).toBe(true);
  });

  test('other errors inherit from LLMAdapterError', () => {
    const manifest = new ManifestError('bad manifest');
    const tool = new ToolExecutionError('tool failed');
    const mcp = new MCPConnectionError('mcp offline');
    const payload = new ProviderPayloadError('invalid payload');

    for (const err of [manifest, tool, mcp, payload]) {
      expect(err).toBeInstanceOf(LLMAdapterError);
      expect(err.name).toMatch(/Error$/);
    }
  });
});
