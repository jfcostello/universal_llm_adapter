import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type {
  ObservabilityProviderManifest,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '@/modules/kernel/index.ts';
import { LangfuseCompat } from '@/plugins/observability-compat/langfuse/internal/langfuse.ts';
import defaultCompat from '@/plugins/observability-compat/langfuse/index.ts';

// Mock fetch
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

describe('LangfuseCompat', () => {
  let langfuseCompat: LangfuseCompat;
  let originalEnv: NodeJS.ProcessEnv;

  const mockManifest: ObservabilityProviderManifest = {
    id: 'langfuse',
    compat: 'langfuse',
    endpoint: {
      urlTemplate: 'https://cloud.langfuse.com/api/public/ingestion',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    },
    auth: {
      type: 'basic',
      publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
      secretKeyEnv: 'LANGFUSE_SECRET_KEY'
    }
  };

  const mockRequestEvent: ObservabilityLLMRequestEvent = {
    traceId: 'trace-123',
    sessionId: 'session-456',
    timestamp: '2024-01-01T00:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ],
    tools: [{ name: 'calculator', description: 'Calculate' }],
    settings: { temperature: 0.7 },
    metadata: { custom: 'value' }
  };

  const mockResponseEvent: ObservabilityLLMResponseEvent = {
    traceId: 'trace-123',
    timestamp: '2024-01-01T00:00:01.000Z',
    provider: 'openai',
    model: 'gpt-4',
    content: [{ type: 'text', text: 'Hello there!' }],
    toolCalls: [{ id: 'call-1', name: 'calculator', arguments: { x: 1 } }],
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30
    },
    durationMs: 1000,
    metadata: { custom: 'response-value' }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-456';

    langfuseCompat = new LangfuseCompat();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('buildBatch', () => {
    it('builds batch from request event', () => {
      const result = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);

      expect(result.payload).toBeDefined();
      expect(result.payload.batch).toHaveLength(2); // trace-create + generation-create
      expect(result.eventIndexByEnvelopeId.size).toBeGreaterThan(0);

      // Check trace-create event
      const traceEvent = result.payload.batch.find((e: any) => e.type === 'trace-create');
      expect(traceEvent).toBeDefined();
      expect(traceEvent!.body.id).toBe('trace-123');
      expect(traceEvent!.body.sessionId).toBe('session-456');
      expect(traceEvent!.body.name).toBe('openai/gpt-4');
      expect(traceEvent!.body.input).toEqual(mockRequestEvent.messages);

      // Check generation-create event
      const genEvent = result.payload.batch.find((e: any) => e.type === 'generation-create');
      expect(genEvent).toBeDefined();
      expect(genEvent!.body.traceId).toBe('trace-123');
      expect(genEvent!.body.model).toBe('gpt-4');
      expect(genEvent!.body.modelParameters).toEqual({ temperature: 0.7 });
    });

    it('builds batch from response event', () => {
      const result = langfuseCompat.buildBatch([mockResponseEvent], mockManifest);

      expect(result.payload.batch).toHaveLength(1); // generation-update
      expect(result.eventIndexByEnvelopeId.size).toBeGreaterThan(0);

      // Check generation-update event
      const updateEvent = result.payload.batch[0];
      expect(updateEvent.type).toBe('generation-update');
      expect(updateEvent.body.traceId).toBe('trace-123');
      expect(updateEvent.body.output).toEqual(mockResponseEvent.content);
      expect(updateEvent.body.usage).toEqual({
        input: 10,
        output: 20,
        total: 30,
        unit: 'TOKENS'
      });
    });

    it('builds batch from mixed request and response events', () => {
      const result = langfuseCompat.buildBatch([mockRequestEvent, mockResponseEvent], mockManifest);

      expect(result.payload.batch).toHaveLength(3); // 2 for request + 1 for response
    });

    it('handles response event with error', () => {
      const errorEvent: ObservabilityLLMResponseEvent = {
        ...mockResponseEvent,
        error: {
          message: 'Rate limit exceeded',
          code: 'rate_limit',
          retryable: true
        }
      };

      const result = langfuseCompat.buildBatch([errorEvent], mockManifest);

      const updateEvent = result.payload.batch[0];
      expect(updateEvent.body.level).toBe('ERROR');
      expect(updateEvent.body.statusMessage).toBe('Rate limit exceeded');
      expect((updateEvent.body.metadata as any).errorCode).toBe('rate_limit');
      expect((updateEvent.body.metadata as any).retryable).toBe(true);
    });

    it('handles response event without usage', () => {
      const noUsageEvent: ObservabilityLLMResponseEvent = {
        traceId: 'trace-789',
        timestamp: '2024-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Response' }]
      };

      const result = langfuseCompat.buildBatch([noUsageEvent], mockManifest);

      const updateEvent = result.payload.batch[0];
      expect(updateEvent.body.usage).toBeUndefined();
    });

    it('includes SDK metadata in payload', () => {
      const result = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);

      expect(result.payload.metadata).toEqual({
        sdk_name: 'universal-llm-adapter',
        sdk_version: '1.0.0'
      });
    });

    it('handles request event without optional fields', () => {
      const minimalRequest: ObservabilityLLMRequestEvent = {
        traceId: 'trace-min',
        timestamp: '2024-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-4',
        messages: []
      };

      const result = langfuseCompat.buildBatch([minimalRequest], mockManifest);

      expect(result.payload.batch).toHaveLength(2);
      const traceEvent = result.payload.batch.find((e: any) => e.type === 'trace-create');
      expect(traceEvent!.body.sessionId).toBeUndefined();
    });

    it('handles response event without durationMs', () => {
      const noDurationEvent: ObservabilityLLMResponseEvent = {
        traceId: 'trace-123',
        timestamp: '2024-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-4',
        content: []
      };

      const result = langfuseCompat.buildBatch([noDurationEvent], mockManifest);
      const updateEvent = result.payload.batch[0];
      expect((updateEvent.body.metadata as any).durationMs).toBeUndefined();
    });
  });

  describe('sendBatch', () => {
    it('sends batch with basic auth', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [{ id: 'uuid-1', status: 200 }], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(true);
      expect(result.outcomes.length).toBeGreaterThan(0);

      // Check auth header
      const fetchCall = mockFetch.mock.calls[0];
      const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>;
      const expectedAuth = Buffer.from('pk-test-123:sk-test-456').toString('base64');
      expect(headers['Authorization']).toBe(`Basic ${expectedAuth}`);
    });

    it('aborts fetch when context.timeoutMs elapses', async () => {
      mockFetch.mockImplementationOnce((_url: any, init: any) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) {
            reject(new Error('Missing signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }) as any;
      });

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest, { timeoutMs: 10 });

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => o.retryable)).toBe(true);
      expect(result.outcomes[0].error).toBe('Aborted');
    });

    it('sends to correct URL', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      await langfuseCompat.sendBatch(payload, mockManifest);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://cloud.langfuse.com/api/public/ingestion');
    });

    it('handles 207 partial success', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 207,
        json: async () => ({
          successes: [{ id: 'uuid-1', status: 200 }],
          errors: [{ id: 'uuid-2', status: 400, message: 'Invalid event' }]
        })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent, mockResponseEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes).toHaveLength(2);

      const successOutcome = result.outcomes.find(o => o.success);
      expect(successOutcome).toBeDefined();
      expect(successOutcome!.envelopeId).toBe('uuid-1');

      const errorOutcome = result.outcomes.find(o => !o.success);
      expect(errorOutcome).toBeDefined();
      expect(errorOutcome!.error).toBe('Invalid event');
      expect(errorOutcome!.retryable).toBe(false);
    });

    it('handles 429 rate limit as retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 429,
        statusText: 'Too Many Requests'
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => o.retryable)).toBe(true);
    });

    it('handles 500 server error as retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        statusText: 'Internal Server Error'
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => o.retryable)).toBe(true);
    });

    it('handles 502 bad gateway as retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 502,
        statusText: 'Bad Gateway'
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => o.retryable)).toBe(true);
    });

    it('handles 503 service unavailable as retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 503,
        statusText: 'Service Unavailable'
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => o.retryable)).toBe(true);
    });

    it('handles 400 client error as non-retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 400,
        statusText: 'Bad Request'
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => !o.retryable)).toBe(true);
    });

    it('handles 401 unauthorized as non-retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        statusText: 'Unauthorized'
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => !o.retryable)).toBe(true);
    });

    it('handles network errors as retryable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes.every(o => o.retryable)).toBe(true);
      expect(result.outcomes[0].error).toBe('Network error');
    });

    it('handles 200 with empty response', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({})
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      // Should assume success for all events when no outcomes parsed
      expect(result.success).toBe(true);
      expect(result.outcomes.length).toBeGreaterThan(0);
      expect(result.outcomes.every(o => o.success)).toBe(true);
    });

    it('handles manifest without auth', async () => {
      const noAuthManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        auth: undefined
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], noAuthManifest);
      await langfuseCompat.sendBatch(payload, noAuthManifest);

      const fetchCall = mockFetch.mock.calls[0];
      const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('handles auth config without env var names', async () => {
      const noEnvVarManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        auth: {
          type: 'basic'
          // No publicKeyEnv or secretKeyEnv
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], noEnvVarManifest);
      await langfuseCompat.sendBatch(payload, noEnvVarManifest);

      const fetchCall = mockFetch.mock.calls[0];
      const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>;
      // Should not include auth header if env var names are not specified
      expect(headers['Authorization']).toBeUndefined();
    });

    it('handles missing env vars for auth', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      await langfuseCompat.sendBatch(payload, mockManifest);

      const fetchCall = mockFetch.mock.calls[0];
      const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>;
      // Should not include auth header if env vars are missing
      expect(headers['Authorization']).toBeUndefined();
    });

    it('handles error with error field instead of message', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 207,
        json: async () => ({
          successes: [],
          errors: [{ id: 'uuid-1', status: 400, error: 'Error from field' }]
        })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.success).toBe(false);
      expect(result.outcomes[0].error).toBe('Error from field');
    });

    it('handles 207 with retryable errors', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 207,
        json: async () => ({
          successes: [],
          errors: [{ id: 'uuid-1', status: 429, message: 'Rate limited' }]
        })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.outcomes[0].retryable).toBe(true);
    });

    it('handles 207 with 500-level errors as retryable', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 207,
        json: async () => ({
          successes: [],
          errors: [{ id: 'uuid-1', status: 503, message: 'Server error' }]
        })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      const result = await langfuseCompat.sendBatch(payload, mockManifest);

      expect(result.outcomes[0].retryable).toBe(true);
    });
  });

  describe('URL template resolution', () => {
    it('allows per-call baseUrl override via providerConfig', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      await langfuseCompat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'https://override.langfuse.com' }
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://override.langfuse.com/api/public/ingestion');
    });

    it('treats providerConfig.baseUrl as full ingestion URL when it includes the ingestion path', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], mockManifest);
      await langfuseCompat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'https://override.langfuse.com/api/public/ingestion' }
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://override.langfuse.com/api/public/ingestion');
    });

    it('handles relative URL templates when baseUrl override is provided', async () => {
      delete process.env.MISSING_VAR;

      const missingManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: '${MISSING_VAR}/api/public/ingestion'
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], missingManifest);
      await langfuseCompat.sendBatch(payload, missingManifest, {
        providerConfig: { baseUrl: 'https://override.langfuse.com' }
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://override.langfuse.com/api/public/ingestion');
    });

    it('handles relative URL templates without a leading slash when baseUrl override is provided', async () => {
      delete process.env.MISSING_VAR;

      const missingManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: '${MISSING_VAR}api/public/ingestion'
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], missingManifest);
      await langfuseCompat.sendBatch(payload, missingManifest, {
        providerConfig: { baseUrl: 'https://override.langfuse.com' }
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://override.langfuse.com/api/public/ingestion');
    });

    it('resolves custom host from env var', async () => {
      process.env.LANGFUSE_HOST = 'https://custom.langfuse.com';

      const customManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: '${LANGFUSE_HOST}/api/public/ingestion'
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], customManifest);
      await langfuseCompat.sendBatch(payload, customManifest);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://custom.langfuse.com/api/public/ingestion');
    });

    it('uses default value when env var not set', async () => {
      delete process.env.LANGFUSE_HOST;

      const defaultManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: '${LANGFUSE_HOST:-https://default.langfuse.com}/api/public/ingestion'
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], defaultManifest);
      await langfuseCompat.sendBatch(payload, defaultManifest);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://default.langfuse.com/api/public/ingestion');
    });

    it('handles URL with no environment variables', async () => {
      const staticManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: 'https://static.langfuse.com/api/public/ingestion'
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], staticManifest);
      await langfuseCompat.sendBatch(payload, staticManifest);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://static.langfuse.com/api/public/ingestion');
    });

    it('returns empty string for unset env vars without default', async () => {
      delete process.env.MISSING_VAR;

      const missingManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: '${MISSING_VAR}/api/public/ingestion'
        }
      };

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ successes: [], errors: [] })
      } as Response);

      const { payload } = langfuseCompat.buildBatch([mockRequestEvent], missingManifest);
      await langfuseCompat.sendBatch(payload, missingManifest);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('/api/public/ingestion');
    });
  });

  describe('default export', () => {
    it('exports a compat constructor for registry loading', () => {
      expect(defaultCompat).toBeDefined();
      expect(typeof defaultCompat).toBe('function');

      const instance = new (defaultCompat as any)();
      expect(typeof instance.buildBatch).toBe('function');
      expect(typeof instance.sendBatch).toBe('function');
    });
  });
});
