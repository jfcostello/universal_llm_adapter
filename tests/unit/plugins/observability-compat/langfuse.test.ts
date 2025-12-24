import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type {
  ObservabilityProviderManifest,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '@/modules/kernel/index.ts';
import { LangfuseCompat } from '@/plugins/observability-compat/langfuse/internal/langfuse.ts';
import defaultCompat from '@/plugins/observability-compat/langfuse/index.ts';

const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

function makeHexTraceId(seed: string): string {
  // Deterministic but simple for tests; must be 32 hex chars.
  return seed.padEnd(32, '0').slice(0, 32);
}

describe('LangfuseCompat (OTLP)', () => {
  let compat: LangfuseCompat;
  let originalEnv: NodeJS.ProcessEnv;

  const traceId = makeHexTraceId('deadbeef');
  const generationId = 'gen-abc';

  const mockManifest: ObservabilityProviderManifest = {
    id: 'langfuse',
    compat: 'langfuse',
    endpoint: {
      urlTemplate: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf'
      }
    },
    auth: {
      type: 'basic',
      publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
      secretKeyEnv: 'LANGFUSE_SECRET_KEY'
    },
    limits: {
      maxBatchBytes: 1024 * 1024
    }
  };

  const requestEvent: ObservabilityLLMRequestEvent = {
    traceId,
    generationId,
    sessionId: 'session-456',
    timestamp: '2024-01-01T00:00:00.000Z',
    provider: 'provider-a',
    model: 'model-a',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys msg' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ],
    tools: [{ name: 'test.echo', description: 'Echo a message' }],
    settings: { temperature: 0.7 },
    requestPayload: { messages: [{ role: 'user', content: 'Hello' }] },
    metadata: { custom: 'value' }
  };

  const responseEvent: ObservabilityLLMResponseEvent = {
    traceId,
    generationId,
    timestamp: '2024-01-01T00:00:01.000Z',
    provider: 'provider-a',
    model: 'model-a',
    content: [{ type: 'text', text: 'Hello there!' }],
    rawResponse: { id: 'raw-1', ok: true },
    toolCalls: [{ id: 'call-1', name: 'test.echo', arguments: { message: 'abc' } }],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    durationMs: 1000,
    metadata: { custom: 'response-value' }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-456';
    delete process.env.LLM_LIVE;
    delete process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE;
    delete process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST;

    compat = new LangfuseCompat();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exports a constructor as default (plugin registry compat loading)', () => {
    expect(typeof defaultCompat).toBe('function');
  });

  describe('buildBatch', () => {
    it('caches request and builds an OTLP span for the paired response', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const reqBatch = compat.buildBatch([requestEvent], mockManifest, ctxReq);
      expect(reqBatch.payload).toBeDefined();

      const respBatch = compat.buildBatch([responseEvent], mockManifest, ctxResp);
      expect(respBatch.payload).toBeDefined();

      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(Array.isArray(spans)).toBe(true);
      expect(spans).toHaveLength(1);

      const span = spans[0];
      const attrs = span?.attributes ?? {};
      expect(String(attrs['langfuse.observation.input'] || '')).toContain('sys msg');
      expect(String(attrs['langfuse.observation.input'] || '')).toContain('Hello');
      expect(String(attrs['langfuse.observation.output'] || '')).toContain('Hello there!');
      expect(String(attrs['langfuse.observation.output'] || '')).toContain('test.echo');

      const input = JSON.parse(String(attrs['langfuse.observation.input'] || '{}'));
      expect(input.requestPayload).toEqual(requestEvent.requestPayload);

      const output = JSON.parse(String(attrs['langfuse.observation.output'] || '{}'));
      expect(output.rawResponse).toEqual(responseEvent.rawResponse);
    });

    it('keeps request context cached after building a response span (for exporter retries)', () => {
      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      expect((compat as any).requestCache.size).toBe(1);

      compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);
      expect((compat as any).requestCache.size).toBe(1);
    });

    it('flattens primitives into adapter text attributes', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      compat.buildBatch([requestEvent], mockManifest, ctxReq);

      const respWithPrimitives: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        toolCalls: [
          {
            id: 'call-1',
            name: 'test.echo',
            arguments: { message: 'abc', count: 2, ok: true, nil: null }
          }
        ]
      };

      const respBatch = compat.buildBatch([respWithPrimitives], mockManifest, ctxResp);
      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(String(span.attributes['llm.adapter.output_text'] || '')).toContain('2');
      expect(String(span.attributes['llm.adapter.output_text'] || '')).toContain('true');
      expect(String(span.attributes['llm.adapter.output_text'] || '')).toContain('abc');
    });

    it('builds a best-effort span even when response arrives without a cached request', () => {
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const respBatch = compat.buildBatch([responseEvent], mockManifest, ctxResp);
      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);
    });

    it('skips unknown event shapes', () => {
      const batch = compat.buildBatch([{ not: 'an event' } as any], mockManifest, { eventIds: ['e1'] } as any);
      expect((batch.payload as any)?.spans ?? []).toHaveLength(0);
      expect(batch.eventIndexByEnvelopeId.size).toBe(0);
    });

    it('uses fallback envelopeId when eventIds are missing and generationId is absent', () => {
      const respNoGen: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        generationId: undefined
      };
      const batch = compat.buildBatch([respNoGen as any], mockManifest, undefined);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans[0]?.envelopeId).toBe('response-0');
    });

    it('uses fallback envelopeId when eventId is blank/whitespace', () => {
      const respNoGen: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        generationId: undefined
      };
      const batch = compat.buildBatch([respNoGen as any], mockManifest, { eventIds: ['   '] } as any);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans[0]?.envelopeId).toBe('response-0');
    });

    it('prunes expired request cache entries', () => {
      const nowSpy = jest.spyOn(Date, 'now');

      nowSpy.mockReturnValue(0);
      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      expect((compat as any).requestCache.size).toBe(1);

      nowSpy.mockReturnValue(10 * 60_000 + 1);
      compat.buildBatch([], mockManifest, undefined);
      expect((compat as any).requestCache.size).toBe(0);

      nowSpy.mockRestore();
    });

    it('falls back to response timestamp when durationMs is missing and model can be empty', () => {
      const resp: ObservabilityLLMResponseEvent = {
        traceId: '' as any,
        generationId: undefined,
        timestamp: '2024-01-01T00:00:01.000Z',
        provider: '' as any,
        model: '' as any,
        content: []
      };

      const batch = compat.buildBatch([resp as any], mockManifest, undefined);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);
      expect(spans[0].startTimeIso).toBe('2024-01-01T00:00:01.000Z');
      expect(spans[0].attributes['langfuse.observation.model.name']).toBe('');
      expect(spans[0].attributes['llm.adapter.provider']).toBe('');
    });

    it('builds spans with error status and falls back to request model and defaults', () => {
      const traceId = makeHexTraceId('cafebabe');
      const generationId = 'gen-error';

      const req: ObservabilityLLMRequestEvent = {
        traceId,
        generationId,
        timestamp: '2024-01-01T00:00:00.000Z',
        provider: 'provider-a',
        model: 'req-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      };

      const resp: ObservabilityLLMResponseEvent = {
        traceId,
        generationId,
        timestamp: '2024-01-01T00:00:01.000Z',
        provider: '' as any,
        model: '' as any,
        content: [{ type: 'text', text: 'oops' }],
        durationMs: -1,
        error: { message: '' } as any
      };

      compat.buildBatch([req], mockManifest, { eventIds: ['req'] } as any);
      const { payload } = compat.buildBatch([resp], mockManifest, { eventIds: ['resp'] } as any);
      const spans = (payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.status).toEqual({ code: 'ERROR', message: 'error' });
      expect(span.attributes['langfuse.observation.model.name']).toBe('req-model');
      expect(span.attributes['llm.adapter.provider']).toBe('provider-a');
      expect(span.attributes['langfuse.session.id']).toBeUndefined();

      const input = JSON.parse(String(span.attributes['langfuse.observation.input']));
      expect(input.tools).toEqual([]);
    });

    it('uses safeJson fallback when serialization fails', () => {
      const traceId = makeHexTraceId('badjson');
      const generationId = 'gen-badjson';

      const req: ObservabilityLLMRequestEvent = {
        traceId,
        generationId,
        timestamp: '2024-01-01T00:00:00.000Z',
        provider: 'provider-a',
        model: 'm',
        messages: [],
        settings: BigInt(1) as any
      };

      const resp: ObservabilityLLMResponseEvent = {
        traceId,
        generationId,
        timestamp: '2024-01-01T00:00:01.000Z',
        provider: 'provider-a',
        model: 'm',
        content: []
      };

      compat.buildBatch([req], mockManifest, { eventIds: ['req'] } as any);
      const { payload } = compat.buildBatch([resp], mockManifest, { eventIds: ['resp'] } as any);
      const spans = (payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      // JSON.stringify fails on BigInt, so safeJson falls back to stringifying String(value).
      expect(spans[0].attributes['langfuse.observation.model.parameters']).toBe('\"1\"');
    });
  });

  describe('sendBatch', () => {
    it('sends OTLP protobuf over HTTP with Basic auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const ctx = { eventIds: ['event-req', 'event-resp'] } as any;
      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload, eventIndexByEnvelopeId } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      // payload should include spans; sendBatch should encode and POST them
      const result = await compat.sendBatch(payload, mockManifest, {
        ...ctx,
        timeoutMs: 1000
      });

      expect(result.success).toBe(true);
      expect(result.outcomes.length).toBe(eventIndexByEnvelopeId.size);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');

      const init = fetchCall?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const expectedAuth = Buffer.from('pk-test-123:sk-test-456').toString('base64');
      expect(headers.Authorization).toBe(`Basic ${expectedAuth}`);
      expect(headers['Content-Type']).toBe('application/x-protobuf');

      const body: any = init.body;
      expect(body).toBeDefined();
      const byteLength = body instanceof Uint8Array ? body.byteLength : Buffer.isBuffer(body) ? body.byteLength : 0;
      expect(byteLength).toBeGreaterThan(0);
    });

    it('supports baseUrl override in live-test mode (for non-blocking failure tests)', async () => {
      process.env.LLM_LIVE = '1';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null },
        text: async () => 'nope'
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://127.0.0.1:1' },
        eventIds: ['event-resp'],
        timeoutMs: 250
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://127.0.0.1:1/api/public/otel/v1/traces');
    });

    it('ignores baseUrl override when not explicitly allowed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://127.0.0.1:1' },
        eventIds: ['event-resp'],
        timeoutMs: 250
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    });

    it('returns success for empty spans payloads', async () => {
      const result = await compat.sendBatch({ spans: [] } as any, mockManifest, { timeoutMs: 1 } as any);
      expect(result).toEqual({ success: true, outcomes: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('treats missing/invalid payload.spans as empty', async () => {
      const result = await compat.sendBatch({} as any, mockManifest, { timeoutMs: 1 } as any);
      expect(result).toEqual({ success: true, outcomes: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('supports baseUrl override via allow env var and allowlist hostname match', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = 'localhost';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://localhost:1234' },
        eventIds: ['event-resp'],
        timeoutMs: 250
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://localhost:1234/api/public/otel/v1/traces');
    });

    it('treats empty allowlist entries as no allowlist (allows override)', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = ',,';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://127.0.0.1:1' }
      } as any);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://127.0.0.1:1/api/public/otel/v1/traces');
    });

    it('allows baseUrl overrides when allowlist matches host (including port)', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = 'localhost:1234';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://localhost:1234' }
      } as any);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://localhost:1234/api/public/otel/v1/traces');
    });

    it('blocks baseUrl overrides when allowlist does not include the host', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = 'example.com';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://localhost:1234' }
      } as any);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    });

    it('rejects invalid, credentialed, unsupported-protocol, and path-mismatched baseUrl overrides', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = '127.0.0.1';

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, { providerConfig: { baseUrl: 'not-a-url' } } as any);
      await compat.sendBatch(payload, mockManifest, { providerConfig: { baseUrl: 'http://u:p@127.0.0.1:1' } } as any);
      await compat.sendBatch(payload, mockManifest, { providerConfig: { baseUrl: 'file://127.0.0.1' } } as any);
      await compat.sendBatch(payload, mockManifest, { providerConfig: { baseUrl: 'http://127.0.0.1:1/wrong' } } as any);

      for (const call of mockFetch.mock.calls) {
        expect(call?.[0]).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
      }
    });

    it('accepts a full baseUrl override only when it matches the ingestion path', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = '127.0.0.1';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, mockManifest, {
        providerConfig: { baseUrl: 'http://127.0.0.1:1/api/public/otel/v1/traces' }
      } as any);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://127.0.0.1:1/api/public/otel/v1/traces');
    });

    it('resolves relative templates against baseUrl override and prefixes missing leading slash', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const relativeManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: 'api/public/otel/v1/traces'
        }
      };

      compat.buildBatch([requestEvent], relativeManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], relativeManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, relativeManifest, {
        providerConfig: { baseUrl: 'http://127.0.0.1:1' }
      } as any);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://127.0.0.1:1/api/public/otel/v1/traces');
    });

    it('resolves leading-slash relative templates against baseUrl override', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const relativeManifest: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          urlTemplate: '/api/public/otel/v1/traces'
        }
      };

      compat.buildBatch([requestEvent], relativeManifest, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], relativeManifest, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, relativeManifest, {
        providerConfig: { baseUrl: 'http://127.0.0.1:1' }
      } as any);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall?.[0]).toBe('http://127.0.0.1:1/api/public/otel/v1/traces');
    });

    it('sends with default headers when manifest.endpoint.headers is omitted', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const manifestNoHeaders: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          ...mockManifest.endpoint,
          headers: undefined
        }
      };

      compat.buildBatch([requestEvent], manifestNoHeaders, { eventIds: ['event-req'] } as any);
      const { payload } = compat.buildBatch([responseEvent], manifestNoHeaders, { eventIds: ['event-resp'] } as any);

      await compat.sendBatch(payload, manifestNoHeaders, { timeoutMs: 250 } as any);
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
      expect(headers['Content-Type']).toBe('application/x-protobuf');
    });

    it('throws when auth config is missing, wrong type, missing env names, or missing env values', async () => {
      const payload = {
        spans: [
          {
            traceIdHex: traceId,
            spanIdHex: '0123456789abcdef',
            name: 't',
            startTimeIso: '2024-01-01T00:00:00.000Z',
            endTimeIso: '2024-01-01T00:00:00.000Z',
            envelopeId: 'env-1'
          }
        ]
      };

      await expect(compat.sendBatch(payload, { ...mockManifest, auth: undefined } as any)).rejects.toThrow(
        /requires basic auth/i
      );

      await expect(
        compat.sendBatch(payload, { ...mockManifest, auth: { type: 'bearer' } } as any)
      ).rejects.toThrow(/requires basic auth/i);

      await expect(
        compat.sendBatch(payload, { ...mockManifest, auth: { type: 'basic' } } as any)
      ).rejects.toThrow(/publicKeyEnv and secretKeyEnv/i);

      // Missing only one env var should be reported.
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-123';
      delete process.env.LANGFUSE_SECRET_KEY;
      await expect(compat.sendBatch(payload, mockManifest, {} as any)).rejects.toThrow(/LANGFUSE_SECRET_KEY/);

      process.env.LANGFUSE_SECRET_KEY = 'sk-test-456';
      delete process.env.LANGFUSE_PUBLIC_KEY;
      await expect(compat.sendBatch(payload, mockManifest, {} as any)).rejects.toThrow(/LANGFUSE_PUBLIC_KEY/);
    });
  });
});
