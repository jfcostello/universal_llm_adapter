import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type {
  ObservabilityProviderManifest,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilitySignalEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityTraceUpdateEvent
} from '@/kernel/index.ts';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '@/modules/observability/index.ts';
import { SentryCompat } from '@/plugins/observability-compat/sentry/internal/sentry.ts';
import {
  buildSentryOtlpAuthHeader,
  buildSentrySignalEnvelope,
  normalizeSentryLevel,
  parseSentryDsn,
  resolveSentryDsn
} from '@/plugins/observability-compat/sentry/internal/sentry-helpers.ts';
import defaultCompat from '@/plugins/observability-compat/sentry/index.ts';

const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

function parseEnvelope(body: string): { envelopeHeader: any; itemHeader: any; payload: any } {
  const lines = body.split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  return {
    envelopeHeader: JSON.parse(lines[0]),
    itemHeader: JSON.parse(lines[1]),
    payload: JSON.parse(lines[2])
  };
}

describe('SentryCompat (envelopes + OTLP traces)', () => {
  let compat: SentryCompat;
  let originalEnv: NodeJS.ProcessEnv;

  const traceId = 'trace-xyz';
  const generationId = 'gen-abc';

  const mockManifest: ObservabilityProviderManifest = {
    id: 'sentry',
    compat: 'sentry',
    endpoint: {
      urlTemplate: '${SENTRY_DSN}',
      method: 'POST',
      headers: {}
    }
  };

  const requestEvent: ObservabilityLLMRequestEvent = {
    traceId,
    generationId,
    sessionId: 'session-456',
    timestampMs: 1704067200000,
    provider: 'provider-a',
    model: 'model-a',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys msg' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ],
    tools: [{ name: 'test.echo', description: 'Echo a message' }],
    settings: { temperature: 0.7 },
    requestPayload: { messages: [{ role: 'user', content: 'Hello' }] },
    metadata: { correlationId: 'corr-123', batchId: 'batch-xyz', tags: ['t1'] }
  };

  const responseEvent: ObservabilityLLMResponseEvent = {
    traceId,
    generationId,
    sessionId: 'session-456',
    timestampMs: 1704067201000,
    provider: 'provider-a',
    model: 'model-a',
    content: [{ type: 'text', text: 'Hello there!' }],
    rawResponse: { id: 'raw-1', ok: true },
    toolCalls: [{ id: 'call-1', name: 'test.echo', arguments: { message: 'abc' } }],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    durationMs: 1000,
    metadata: { correlationId: 'corr-123', batchId: 'batch-xyz', tags: ['t1'] }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.SENTRY_DSN = 'https://public123@o0.ingest.sentry.io/42';
    delete process.env.LLM_LIVE;
    compat = new SentryCompat();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exports a constructor as default (plugin registry compat loading)', () => {
    expect(typeof defaultCompat).toBe('function');
  });

  describe('parseSentryDsn', () => {
    it('derives envelope + OTLP trace endpoints (with and without path prefix)', () => {
      const parsed = parseSentryDsn('https://public123@o0.ingest.sentry.io/42');
      expect(parsed.publicKey).toBe('public123');
      expect(parsed.projectId).toBe('42');
      expect(parsed.envelopeUrl).toBe('https://o0.ingest.sentry.io/api/42/envelope/');
      expect(parsed.otlpTracesUrl).toBe('https://o0.ingest.sentry.io/api/42/integration/otlp/v1/traces');

      const parsedWithPrefix = parseSentryDsn('https://public123@sentry.example.com/sentry/prefix/99');
      expect(parsedWithPrefix.envelopeUrl).toBe('https://sentry.example.com/sentry/prefix/api/99/envelope/');
      expect(parsedWithPrefix.otlpTracesUrl).toBe('https://sentry.example.com/sentry/prefix/api/99/integration/otlp/v1/traces');
    });

    it('rejects invalid DSNs', () => {
      expect(() => parseSentryDsn('')).toThrow('Invalid Sentry DSN: empty');
      expect(() => parseSentryDsn('not-a-url')).toThrow('Invalid Sentry DSN');
      expect(() => parseSentryDsn('https://@o0.ingest.sentry.io/42')).toThrow('Sentry DSN missing public key');
      expect(() => parseSentryDsn('https://public123@o0.ingest.sentry.io/')).toThrow('Sentry DSN missing project id');
      expect(() => parseSentryDsn('ftp://public123@o0.ingest.sentry.io/42')).toThrow('Invalid Sentry DSN');
    });
  });

  describe('sentry-helpers', () => {
    it('normalizes Sentry levels and validates OTLP auth header inputs', () => {
      expect(normalizeSentryLevel('debug')).toBe('debug');
      expect(normalizeSentryLevel('warn')).toBe('warning');
      expect(normalizeSentryLevel('')).toBe('info');
      expect(normalizeSentryLevel(123 as any)).toBe('info');

      expect(() => buildSentryOtlpAuthHeader('')).toThrow('Sentry OTLP auth requires a public key');
      expect(buildSentryOtlpAuthHeader(' public ')).toBe('sentry sentry_key=public');
    });

    it('throws when resolving a missing DSN from the provider manifest', () => {
      expect(() => resolveSentryDsn({ ...mockManifest, endpoint: { ...mockManifest.endpoint, urlTemplate: '' } } as any)).toThrow(
        'Missing required env var for Sentry: SENTRY_DSN'
      );
    });

    it('builds a minimal envelope with stable 32-hex event_id and omits optional sections when empty', () => {
      const envelopeId = '0123456789abcdef0123456789abcdef';
      const { body } = buildSentrySignalEnvelope({
        dsn: 'https://public@o0.ingest.sentry.io/42',
        envelopeId,
        event: {
          traceId: 'trace-xyz',
          generationId: undefined,
          timestampMs: 1704067200000,
          level: 'debug',
          message: 'hello'
        } as any,
        traceContext: {},
        context: { maxAttributeValueBytes: 1024 } as any
      });

      const { envelopeHeader, payload } = parseEnvelope(body);
      expect(envelopeHeader.event_id).toBe(envelopeId);
      expect(envelopeHeader.dsn).toBe('https://public@o0.ingest.sentry.io/42');
      expect(payload.event_id).toBe(envelopeId);
      expect(payload.level).toBe('debug');
      expect(payload.message).toBe('hello');
      expect(payload.tags).toBeUndefined();
      expect(payload.extra).toBeUndefined();
      expect(payload.contexts?.trace?.span_id).toBeUndefined();
    });

    it('uses event.code as the message fallback when message is empty', () => {
      const { body } = buildSentrySignalEnvelope({
        dsn: 'https://public@o0.ingest.sentry.io/42',
        envelopeId: 'sig-2',
        event: {
          traceId: 'trace-xyz',
          generationId: undefined,
          timestampMs: 1704067200000,
          level: 'info',
          message: '',
          code: 'code-only'
        } as any,
        traceContext: {},
        context: { maxAttributeValueBytes: 1024 } as any
      });

      const { payload } = parseEnvelope(body);
      expect(payload.message).toBe('code-only');
      expect(payload.extra?.code).toBe('code-only');
    });

    it('includes extra fields, tags, and span linkage when present', () => {
      const { body } = buildSentrySignalEnvelope({
        dsn: 'https://public@o0.ingest.sentry.io/42',
        envelopeId: 'sig-1',
        event: {
          traceId: 'trace-xyz',
          generationId: 'gen-abc',
          timestampMs: 1704067200000,
          level: 'warn',
          stack: 'stack',
          metadata: { deep: { ok: true } },
          source: 'src',
          tags: ['t1']
        } as any,
        traceContext: { sessionId: 'sess', traceName: 'corr', batchId: 'batch', tags: ['a', 'b'] },
        context: { maxAttributeValueBytes: 2048 } as any
      });

      const { payload } = parseEnvelope(body);
      expect(payload.message).toBe('signal');
      expect(payload.tags['llm.adapter.tags']).toBe('a,b');
      expect(payload.extra?.stack).toBe('stack');
      expect(typeof payload.extra?.metadata).toBe('string');
      expect(payload.contexts?.trace?.span_id).toBe(deriveOtlpSpanIdHex('gen-abc'));
    });

    it('derives stable identifiers even when envelopeId and traceId are empty', () => {
      const { body } = buildSentrySignalEnvelope({
        dsn: 'https://public@o0.ingest.sentry.io/42',
        envelopeId: '',
        event: {
          traceId: undefined,
          generationId: undefined,
          timestampMs: 1704067200000,
          level: 'info',
          message: 'ok'
        } as any,
        traceContext: {},
        context: { maxAttributeValueBytes: 1024 } as any
      });

      const { payload } = parseEnvelope(body);
      expect(typeof payload.event_id).toBe('string');
      expect(String(payload.event_id).length).toBe(32);
      expect(payload.contexts?.trace?.trace_id).toBe(deriveOtlpTraceIdHex(''));
    });
  });

  describe('buildBatch', () => {
    it('exports only envelopes by default (OTLP disabled)', () => {
      const signal: ObservabilitySignalEvent = {
        traceId,
        generationId,
        sessionId: 'session-456',
        timestampMs: 1704067200600,
        level: 'warning',
        message: 'warn msg',
        source: 'tool_loop',
        code: 'tool_call_budget_exhausted',
        tags: ['t2'],
        metadata: { correlationId: 'corr-123', batchId: 'batch-xyz', tags: ['t1'] }
      };

      const { payload, eventIndexByEnvelopeId } = compat.buildBatch(
        [requestEvent, responseEvent, { ...signal, type: 'signal' } as any],
        mockManifest,
        { eventIds: ['req', 'resp', 'sig'] } as any
      );

      expect((payload as any).spans).toHaveLength(0);
      expect((payload as any).envelopes).toHaveLength(1);
      expect(eventIndexByEnvelopeId.size).toBe(1);
      expect(eventIndexByEnvelopeId.get('sig')).toBe(2);

      const { envelopeHeader, itemHeader, payload: event } = parseEnvelope((payload as any).envelopes[0].body);
      expect(envelopeHeader.dsn).toBe(process.env.SENTRY_DSN);
      expect(itemHeader.type).toBe('event');
      expect(event.level).toBe('warning');
      expect(event.message).toBe('warn msg');
      expect(event.contexts?.trace?.trace_id).toBe(deriveOtlpTraceIdHex(traceId));
      expect(event.contexts?.trace?.span_id).toBe(deriveOtlpSpanIdHex(generationId));
    });

    it('builds OTLP spans when enableOtlp is set', () => {
      const ctx = { eventIds: ['req', 'resp'], providerConfig: { enableOtlp: true } } as any;
      const { payload, eventIndexByEnvelopeId } = compat.buildBatch([requestEvent, responseEvent], mockManifest, ctx);

      const spans = (payload as any).spans ?? [];
      expect(spans).toHaveLength(1);
      expect(eventIndexByEnvelopeId.get('resp')).toBe(1);

      const span = spans[0];
      expect(span.traceIdHex).toBe(deriveOtlpTraceIdHex(traceId));
      expect(span.spanIdHex).toBe(deriveOtlpSpanIdHex(generationId));
      expect(span.startTimeIso).toBe('2024-01-01T00:00:00.000Z');
      expect(span.endTimeIso).toBe('2024-01-01T00:00:01.000Z');
      expect(span.status).toEqual({ code: 'OK' });

      const attrs = span.attributes ?? {};
      expect(attrs['llm.adapter.trace_id']).toBe(traceId);
      expect(attrs['llm.adapter.session_id']).toBe('session-456');
      expect(attrs['llm.adapter.correlation_id']).toBe('corr-123');
      expect(attrs['llm.adapter.batch_id']).toBe('batch-xyz');
      expect(attrs['llm.adapter.provider']).toBe('provider-a');
      expect(attrs['llm.adapter.model']).toBe('model-a');
      expect(String(attrs['llm.adapter.input_text'] || '')).toContain('Hello');
      expect(String(attrs['llm.adapter.output_text'] || '')).toContain('Hello there!');
    });

    it('maps tool_execution events as child spans and updates cached trace context on trace_update', () => {
      const ctxReq = { eventIds: ['req'], providerConfig: { enableOtlp: true } } as any;
      compat.buildBatch([requestEvent], mockManifest, ctxReq);

      const toolEvent: ObservabilityToolExecutionEvent = {
        traceId,
        generationId,
        sessionId: 'session-456',
        timestampMs: 1704067200500,
        provider: 'provider-a',
        model: 'model-a',
        toolCallId: 'call-1',
        toolName: 'test.echo',
        durationMs: 50,
        args: { text: 'hi' },
        resultText: 'ok',
        result: { ok: true },
        metadata: { correlationId: 'corr-123', batchId: 'batch-xyz', tags: ['t1'] }
      };

      const toolBatch = compat.buildBatch([{ ...toolEvent, type: 'tool_execution' } as any], mockManifest, { eventIds: ['tool'], providerConfig: { enableOtlp: true } } as any);
      const toolSpans = (toolBatch.payload as any)?.spans ?? [];
      expect(toolSpans).toHaveLength(1);

      const toolSpan = toolSpans[0];
      expect(toolSpan.parentSpanIdHex).toBe(deriveOtlpSpanIdHex(generationId));
      expect(toolSpan.startTimeIso).toBe('2024-01-01T00:00:00.450Z');
      expect(toolSpan.endTimeIso).toBe('2024-01-01T00:00:00.500Z');
      expect(toolSpan.attributes?.['llm.adapter.tool_name']).toBe('test.echo');
      expect(toolSpan.attributes?.['llm.adapter.tool_call_id']).toBe('call-1');

      const update: ObservabilityTraceUpdateEvent = {
        traceId,
        generationId,
        timestampMs: 1704067200601,
        name: 'corr-updated',
        tags: [' updated ']
      };

      compat.buildBatch([{ ...update, type: 'trace_update' } as any], mockManifest, { eventIds: ['update'], providerConfig: { enableOtlp: true } } as any);

      const respUpdated = compat.buildBatch([responseEvent], mockManifest, { eventIds: ['resp'], providerConfig: { enableOtlp: true } } as any);
      const updatedAttrs = (respUpdated.payload as any)?.spans?.[0]?.attributes ?? {};
      expect(updatedAttrs['llm.adapter.correlation_id']).toBe('corr-updated');
      expect(updatedAttrs['llm.adapter.tags']).toEqual(['updated']);
    });

    it('covers response fallbacks when request cache is missing and error variants are present', () => {
      const respNoCache: any = {
        traceId: '',
        generationId: undefined,
        timestampMs: 1704067200100,
        durationMs: 0,
        provider: '',
        model: '',
        content: [],
        error: {}
      };

      const { payload } = compat.buildBatch([respNoCache], mockManifest, { eventIds: ['resp'], providerConfig: { enableOtlp: true } } as any);
      const spans = (payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.status).toEqual({ code: 'ERROR', message: 'error' });
      const attrs = span.attributes ?? {};
      expect(attrs['llm.adapter.trace_id']).toBe('');
      expect(attrs['llm.adapter.provider']).toBe('');
      expect(attrs['llm.adapter.model']).toBe('');
      expect(attrs['llm.adapter.input_text']).toBe('');
    });

    it('skips tool_execution spans when enableOtlp is disabled and ignores unknown event shapes', () => {
      const toolEvent: any = { type: 'tool_execution', traceId, generationId, timestampMs: 1704067200500, durationMs: 1 };
      const unknownEvent: any = { type: 123, foo: 'bar' };

      const batch = compat.buildBatch([toolEvent, unknownEvent], mockManifest, { eventIds: ['tool', 'unknown'] } as any);
      expect((batch.payload as any).spans).toHaveLength(0);
      expect((batch.payload as any).envelopes).toHaveLength(0);
    });

    it('prunes expired request cache entries', () => {
      const key = `${traceId}:${generationId}`;
      (compat as any).requestCache.set(key, {
        summary: { startTimeIso: '2024-01-01T00:00:00.000Z', provider: '', model: '', inputText: '', observationInput: '', modelParameters: '' },
        createdAtMs: Date.now() - (10 * 60_000) - 1
      });

      compat.buildBatch([], mockManifest, { eventIds: [] } as any);
      expect((compat as any).requestCache.get(key)).toBeUndefined();
    });

    it('covers tool_execution mapping variants (missing ids, skipped, and error branches)', () => {
      const events: any[] = [
        {
          type: 'tool_execution',
          traceId,
          generationId: undefined,
          timestampMs: 1704067200525,
          durationMs: '25',
          error: { message: 'boom' }
        },
        {
          type: 'tool_execution',
          traceId: '',
          generationId: undefined,
          timestampMs: 1704067200530,
          durationMs: 0,
          error: {}
        },
        {
          type: 'tool_execution',
          traceId,
          generationId: undefined,
          timestampMs: 1704067200600,
          durationMs: -1,
          skipped: true,
          skipReason: 'policy'
        },
        {
          type: 'tool_execution',
          traceId,
          generationId: undefined,
          timestampMs: 1704067200650,
          durationMs: 0,
          skipped: true
        }
      ];

      const batch = compat.buildBatch(events, mockManifest, { eventIds: ['t0', 't1', 't2', 't3'], providerConfig: { enableOtlp: true } } as any);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(4);

      expect(spans[0].parentSpanIdHex).toBeUndefined();
      expect(spans[0].status).toEqual({ code: 'ERROR', message: 'boom' });
      expect(spans[0].attributes?.['llm.adapter.output_text']).toBe('boom');

      expect(spans[1].status).toEqual({ code: 'ERROR', message: 'error' });
      expect(spans[1].attributes?.['llm.adapter.trace_id']).toBe('');
      expect(spans[1].attributes?.['llm.adapter.input_text']).toBe('');

      expect(spans[2].attributes?.['llm.adapter.tool_skipped']).toBe(true);
      expect(spans[2].attributes?.['llm.adapter.tool_skip_reason']).toBe('policy');
      expect(spans[2].attributes?.['llm.adapter.output_text']).toBe('policy');

      expect(spans[3].attributes?.['llm.adapter.tool_skipped']).toBe(true);
      expect(spans[3].attributes?.['llm.adapter.tool_skip_reason']).toBeUndefined();
      expect(spans[3].attributes?.['llm.adapter.output_text']).toBe('');
    });
  });

  describe('sendBatch', () => {
    it('sends envelopes over HTTP and returns per-envelope outcomes (OTLP disabled)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const signal: ObservabilitySignalEvent = {
        traceId,
        generationId,
        timestampMs: 1704067200600,
        level: 'error',
        message: 'boom'
      };

      const { payload, eventIndexByEnvelopeId } = compat.buildBatch(
        [{ ...signal, type: 'signal' } as any],
        mockManifest,
        { eventIds: ['sig'] } as any
      );

      const result = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, eventIds: ['sig'] } as any);
      expect(result.success).toBe(true);
      expect(result.outcomes).toHaveLength(eventIndexByEnvelopeId.size);

      const call = mockFetch.mock.calls[0];
      expect(call?.[0]).toBe('https://o0.ingest.sentry.io/api/42/envelope/');
      const init = call?.[1] as RequestInit;
      expect((init.headers as any)?.['Content-Type']).toBe('application/x-sentry-envelope');
      expect(typeof init.body).toBe('string');
    });

    it('sends OTLP spans to the derived Sentry OTLP endpoint when enableOtlp is set', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const signal: ObservabilitySignalEvent = {
        traceId,
        generationId,
        timestampMs: 1704067200600,
        level: 'warning',
        message: 'warn msg'
      };

      const { payload, eventIndexByEnvelopeId } = compat.buildBatch(
        [requestEvent, responseEvent, { ...signal, type: 'signal' } as any],
        mockManifest,
        { eventIds: ['req', 'resp', 'sig'], providerConfig: { enableOtlp: true } } as any
      );

      const result = await compat.sendBatch(payload, mockManifest, {
        timeoutMs: 1000,
        eventIds: ['req', 'resp', 'sig'],
        providerConfig: { enableOtlp: true }
      } as any);

      expect(result.outcomes).toHaveLength(eventIndexByEnvelopeId.size);

      const urls = mockFetch.mock.calls.map(c => String(c?.[0] || ''));
      expect(urls).toContain('https://o0.ingest.sentry.io/api/42/envelope/');
      expect(urls).toContain('https://o0.ingest.sentry.io/api/42/integration/otlp/v1/traces');

      const otlpCallIndex = urls.findIndex(u => u.endsWith('/integration/otlp/v1/traces'));
      const otlpInit = mockFetch.mock.calls[otlpCallIndex]?.[1] as RequestInit;
      const headers = otlpInit.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-protobuf');
      expect(headers['x-sentry-auth']).toBe('sentry sentry_key=public123');
    });

    it('marks envelope failures retryable for 429/5xx and non-retryable for 4xx', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null }
      } as any);

      const signal: ObservabilitySignalEvent = {
        traceId,
        generationId,
        timestampMs: 1704067200600,
        level: 'error',
        message: 'boom'
      };

      const { payload } = compat.buildBatch([{ ...signal, type: 'signal' } as any], mockManifest, { eventIds: ['sig'] } as any);
      const result503 = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, eventIds: ['sig'] } as any);
      expect(result503.success).toBe(false);
      expect(result503.outcomes[0]).toEqual(
        expect.objectContaining({ envelopeId: 'sig', success: false, status: 503, retryable: true })
      );

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: { get: () => null }
      } as any);

      const result400 = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, eventIds: ['sig'] } as any);
      expect(result400.outcomes[0]).toEqual(
        expect.objectContaining({ envelopeId: 'sig', success: false, status: 400, retryable: false })
      );
    });

    it('treats invalid payload shapes as empty', async () => {
      const result = await compat.sendBatch({ spans: 'nope', envelopes: {} } as any, mockManifest, { timeoutMs: 1 } as any);
      expect(result).toEqual({ success: true, outcomes: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('formats non-ok envelope errors without statusText', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: '',
        headers: { get: () => null }
      } as any);

      const { payload } = compat.buildBatch(
        [{ type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'error', message: 'boom' } as any],
        mockManifest,
        { eventIds: ['sig'] } as any
      );

      const result = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, eventIds: ['sig'] } as any);
      expect(result.success).toBe(false);
      expect(result.outcomes[0]).toEqual(expect.objectContaining({ envelopeId: 'sig', status: 500, error: 'HTTP 500' }));
    });

    it('marks envelope fetch rejections retryable and supports string error fallbacks', async () => {
      mockFetch.mockRejectedValueOnce('boom');

      const { payload } = compat.buildBatch(
        [{ type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'error', message: 'boom' } as any],
        mockManifest,
        { eventIds: ['sig'] } as any
      );

      const result = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, eventIds: ['sig'] } as any);
      expect(result.success).toBe(false);
      expect(result.outcomes[0]).toEqual(expect.objectContaining({ envelopeId: 'sig', retryable: true, error: 'boom' }));
    });

    it('throws AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const { payload } = compat.buildBatch(
        [{ type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'error', message: 'boom' } as any],
        mockManifest,
        { eventIds: ['sig'] } as any
      );

      await expect(
        compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, signal: controller.signal } as any)
      ).rejects.toThrow('Aborted');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('aborts in-flight envelope exports when the external signal aborts', async () => {
      const controller = new AbortController();

      mockFetch.mockImplementationOnce((_url: any, init: any) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => {
              const err = new Error('Aborted');
              (err as any).name = 'AbortError';
              reject(err);
            },
            { once: true }
          );
        });
      });

      const { payload } = compat.buildBatch(
        [{ type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'error', message: 'boom' } as any],
        mockManifest,
        { eventIds: ['sig'] } as any
      );

      const promise = compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, signal: controller.signal } as any);
      controller.abort();
      await expect(promise).rejects.toThrow('Aborted');
    });

    it('aborts in-flight envelope exports on timeout (covers AbortController timeout path)', async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementationOnce((_url: any, init: any) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => {
              const err = new Error('Aborted');
              (err as any).name = 'AbortError';
              reject(err);
            },
            { once: true }
          );
        });
      });

      const { payload } = compat.buildBatch(
        [{ type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'error', message: 'boom' } as any],
        mockManifest,
        { eventIds: ['sig'] } as any
      );

      const promise = compat.sendBatch(payload, mockManifest, { timeoutMs: 1 } as any);
      jest.advanceTimersByTime(2);
      await expect(promise).rejects.toThrow('Aborted');

      jest.useRealTimers();
    });

    it('skips OTLP export when enableOtlp is set but spans are empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const { payload } = compat.buildBatch(
        [{ type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'warning', message: 'warn msg' } as any],
        mockManifest,
        { eventIds: ['sig'], providerConfig: { enableOtlp: true } } as any
      );

      await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, providerConfig: { enableOtlp: true } } as any);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0]?.[0] || '')).toBe('https://o0.ingest.sentry.io/api/42/envelope/');
    });

    it('marks the batch as failed when OTLP export fails (overallSuccess false)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null }
      } as any);

      const { payload } = compat.buildBatch(
        [requestEvent, responseEvent, { type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'warning', message: 'warn msg' } as any],
        mockManifest,
        { eventIds: ['req', 'resp', 'sig'], providerConfig: { enableOtlp: true } } as any
      );

      const result = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000, providerConfig: { enableOtlp: true } } as any);
      expect(result.success).toBe(false);

      const otlpOutcome = result.outcomes.find(o => o.envelopeId === 'resp');
      expect(otlpOutcome).toEqual(expect.objectContaining({ success: false, status: 503, retryable: true }));
    });

    it('handles manifests without endpoint.headers and treats invalid timeoutMs as undefined', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null }
      } as any);

      const manifestNoHeaders: ObservabilityProviderManifest = {
        ...mockManifest,
        endpoint: {
          urlTemplate: '${SENTRY_DSN}',
          method: 'POST'
        } as any
      };

      const { payload } = compat.buildBatch(
        [requestEvent, responseEvent, { type: 'signal', traceId, generationId, timestampMs: 1704067200600, level: 'warning', message: 'warn msg' } as any],
        manifestNoHeaders,
        { eventIds: ['req', 'resp', 'sig'], providerConfig: { enableOtlp: true } } as any
      );

      const result = await compat.sendBatch(payload, manifestNoHeaders, { timeoutMs: 'nope' as any, providerConfig: { enableOtlp: true } } as any);
      expect(result.success).toBe(true);
    });

    it('returns success for empty payloads', async () => {
      const result = await compat.sendBatch({ spans: [], envelopes: [] } as any, mockManifest, { timeoutMs: 1 } as any);
      expect(result).toEqual({ success: true, outcomes: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
