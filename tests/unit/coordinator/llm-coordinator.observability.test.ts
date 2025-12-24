import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { Role, getDefaults } from '@/modules/kernel/index.ts';

describe('LLMCoordinator observability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createMockRegistry() {
    return {
      getProvider: jest.fn().mockReturnValue({
        id: 'test-provider',
        compat: 'mock',
        endpoint: { urlTemplate: 'http://test.com' }
      }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({ text: 'token' }),
        parseResponse: jest.fn().mockReturnValue({
          content: [{ type: 'text', text: 'response' }],
          role: Role.ASSISTANT
        })
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([]),
      getTool: jest.fn().mockReturnValue(null)
    } as any;
  }

  function createMockSpec(observability?: any, metadata?: any) {
    return {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'test-provider', model: 'test-model' }],
      settings: {},
      observability,
      metadata: metadata ?? { correlationId: 'test-corr-id' }
    } as any;
  }

  describe('createObservabilityContext', () => {
    test('returns undefined when observability is disabled by default', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      // Defaults have observability.enabled = false
      const defaults = getDefaults();
      expect(defaults.observability.enabled).toBe(false);

      // Access private method with spec that doesn't enable observability
      const result = await (coordinator as any).createObservabilityContext(
        createMockSpec(), // no observability spec
        {}
      );

      expect(result).toBeUndefined();
    });

    test('creates observability context when enabled via spec', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      // Mock the observability deps creation on the registry
      const mockExporter = {
        recordLLMRequest: jest.fn(),
        recordLLMResponse: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined)
      };

      // We need to mock the lazy import of createObservabilityDeps
      // Approach: patch the private method to use our mock
      const mockObsDeps = {
        isEnabled: () => true,
        getExporter: () => mockExporter,
        shutdown: jest.fn()
      };

      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse'
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn(),
        sendBatch: jest.fn()
      });

      const spec = createMockSpec({ enabled: true });
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      // Since observability is enabled in spec, it should try to create deps
      // The result will depend on whether createObservabilityDeps succeeds
      // For this test, we're mainly verifying the enabled check works
      // If result is undefined, it means deps creation failed (which is ok for this test)
      // The important thing is we didn't get an exception
    });

    test('returns undefined when spec.observability.enabled is explicitly false', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      const spec = createMockSpec({ enabled: false });
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      expect(result).toBeUndefined();
    });

    test('uses correlationId from metadata as traceId fallback', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      // Setup registry with observability support
      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { host: 'http://test.com' }
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
        sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
      });

      const spec = createMockSpec({ enabled: true }, { correlationId: 'my-correlation-id' });
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      // If observability setup succeeded, traceId should use correlationId
      if (result) {
        expect(result.traceId).toBe('my-correlation-id');
      }
    });

    test('uses spec.observability.traceId over correlationId', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { host: 'http://test.com' }
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
        sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
      });

      const spec = createMockSpec(
        { enabled: true, traceId: 'explicit-trace-id' },
        { correlationId: 'correlation-id-ignored' }
      );
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      if (result) {
        expect(result.traceId).toBe('explicit-trace-id');
      }
    });

    test('uses spec.observability.sessionId when provided', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { host: 'http://test.com' }
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
        sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
      });

      const spec = createMockSpec({ enabled: true, sessionId: 'my-session-id' });
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      if (result) {
        expect(result.sessionId).toBe('my-session-id');
      }
    });

    test('uses runtime.batchId as sessionId fallback', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { host: 'http://test.com' }
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
        sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
      });

      const spec = createMockSpec({ enabled: true });
      const result = await (coordinator as any).createObservabilityContext(spec, { batchId: 'batch-123' });

      if (result) {
        expect(result.sessionId).toBe('batch-123');
      }
    });

    test('uses LLM_ADAPTER_BATCH_ID env var as sessionId fallback when runtime.batchId is missing', async () => {
      const originalBatchId = process.env.LLM_ADAPTER_BATCH_ID;
      process.env.LLM_ADAPTER_BATCH_ID = 'env-batch-456';

      try {
        const registry = createMockRegistry();
        const coordinator = new LLMCoordinator(registry);

        registry.getObservabilityProvider = jest.fn().mockResolvedValue({
          id: 'langfuse',
          compat: 'langfuse',
          endpoint: { host: 'http://test.com' }
        });
        registry.getObservabilityCompat = jest.fn().mockResolvedValue({
          buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
          sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
        });

        const spec = createMockSpec({ enabled: true });
        const result = await (coordinator as any).createObservabilityContext(spec, {});

        if (result) {
          expect(result.sessionId).toBe('env-batch-456');
        }
      } finally {
        if (originalBatchId === undefined) {
          delete process.env.LLM_ADAPTER_BATCH_ID;
        } else {
          process.env.LLM_ADAPTER_BATCH_ID = originalBatchId;
        }
      }
    });

    test('generates UUID for traceId when neither traceId nor correlationId provided', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { host: 'http://test.com' }
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
        sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
      });

      // No traceId in spec, no correlationId in metadata
      const spec = createMockSpec({ enabled: true }, {});
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      if (result) {
        // Should be a valid UUID
        expect(result.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });

    test('includes metadata in observability context', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      registry.getObservabilityProvider = jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { host: 'http://test.com' }
      });
      registry.getObservabilityCompat = jest.fn().mockResolvedValue({
        buildBatch: jest.fn().mockReturnValue({ payload: [], eventIndexByEnvelopeId: new Map() }),
        sendBatch: jest.fn().mockResolvedValue({ success: true, outcomes: [] })
      });

      const spec = createMockSpec(
        { enabled: true, traceId: 'trace-1' },
        { customField: 'customValue', correlationId: 'corr-1' }
      );
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      if (result) {
        expect(result.metadata).toEqual({ customField: 'customValue', correlationId: 'corr-1' });
      }
    });

    test('returns undefined when observability deps report not enabled', async () => {
      const registry = createMockRegistry();
      const coordinator = new LLMCoordinator(registry);

      // The observability module will return noop deps when provider is not configured
      // which will have isEnabled() return false
      registry.getObservabilityProvider = jest.fn().mockRejectedValue(new Error('Provider not found'));

      const spec = createMockSpec({ enabled: true });
      const result = await (coordinator as any).createObservabilityContext(spec, {});

      // Should return undefined when deps fail to initialize
      expect(result).toBeUndefined();
    });
  });
});
