import {
  LLMAdapterError,
  ManifestError,
  ProviderExecutionError,
  ToolExecutionError,
  MCPConnectionError,
  ProviderPayloadError
} from '@/kernel/index.ts';

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

  test('LLMAdapterError instanceof checks survive cross-module copies', () => {
    const chainSymbol = Symbol.for('llm_adapter_error_chain');

    const err = new ManifestError('bad manifest');
    expect(err).toBeInstanceOf(ManifestError);
    expect(err).toBeInstanceOf(LLMAdapterError);
    expect((err as any)[chainSymbol]).toContain('ManifestError');
  });

  test('LLMAdapterError Symbol.hasInstance handles non-object inputs', () => {
    expect(LLMAdapterError[Symbol.hasInstance](null)).toBe(false);
    expect(LLMAdapterError[Symbol.hasInstance](undefined)).toBe(false);
    expect(LLMAdapterError[Symbol.hasInstance]('nope')).toBe(false);
  });

  test('LLMAdapterError instanceof fallback tolerates odd prototype constructors', () => {
    const weirdProto = { constructor: { name: 123 } };
    const weird = Object.create(weirdProto);
    expect(LLMAdapterError[Symbol.hasInstance](weird)).toBe(false);
  });

  test('LLMAdapterError constructor tolerates non-extensible environments', () => {
    const chainSymbol = Symbol.for('llm_adapter_error_chain');
    const originalDefine = Object.defineProperty;

    try {
      Object.defineProperty = ((...args: any[]) => {
        const [, prop] = args;
        if (prop === chainSymbol) {
          throw new Error('defineProperty blocked');
        }
        return (originalDefine as any)(...args);
      }) as any;

      const err = new ManifestError('bad manifest');
      expect((err as any)[chainSymbol]).toBeUndefined();
      expect(err).toBeInstanceOf(ManifestError);
      expect(err).toBeInstanceOf(LLMAdapterError);
    } finally {
      Object.defineProperty = originalDefine;
    }
  });
});
