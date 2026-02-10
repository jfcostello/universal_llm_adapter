import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type {
  ObservabilityProviderManifest,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilitySignalEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityTraceUpdateEvent
} from '@/kernel/index.ts';
import { deriveOtlpSpanIdHex } from '@/modules/observability/index.ts';
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

  const requestEvent: any = {
    traceId,
    generationId,
    sessionId: 'session-456',
    // Intentionally mismatch timestamp vs timestampMs to ensure compat prefers timestampMs.
    timestamp: '1999-01-01T00:00:00.000Z',
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
    metadata: { custom: 'value', correlationId: 'corr-123', batchId: 'batch-xyz' }
  };

  const responseEvent: any = {
    traceId,
    generationId,
    sessionId: 'session-456',
    timestamp: '1999-01-01T00:00:01.000Z',
    timestampMs: 1704067201000,
    provider: 'provider-a',
    model: 'model-a',
    content: [{ type: 'text', text: 'Hello there!' }],
    rawResponse: { id: 'raw-1', ok: true },
    toolCalls: [{ id: 'call-1', name: 'test.echo', arguments: { message: 'abc' } }],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    durationMs: 1000,
    metadata: { custom: 'response-value', correlationId: 'corr-123', batchId: 'batch-xyz' }
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
      expect(span.startTimeIso).toBe('2024-01-01T00:00:00.000Z');
      expect(span.endTimeIso).toBe('2024-01-01T00:00:01.000Z');
      const attrs = span?.attributes ?? {};
      expect(String(attrs['langfuse.observation.input'] || '')).toContain('sys msg');
      expect(String(attrs['langfuse.observation.input'] || '')).toContain('Hello');
      expect(String(attrs['langfuse.observation.output'] || '')).toContain('Hello there!');
      expect(String(attrs['langfuse.observation.output'] || '')).toContain('test.echo');
      expect(attrs['langfuse.trace.name']).toBe('batch-xyz');
      expect(attrs['llm.adapter.trace_id']).toBe(traceId);
      expect(attrs['llm.adapter.session_id']).toBe('session-456');
      expect(attrs['llm.adapter.correlation_id']).toBe('corr-123');
      expect(attrs['llm.adapter.batch_id']).toBe('batch-xyz');

      const input = JSON.parse(String(attrs['langfuse.observation.input'] || '{}'));
      expect(input.requestPayload).toEqual(requestEvent.requestPayload);

      const output = JSON.parse(String(attrs['langfuse.observation.output'] || '{}'));
      expect(output.rawResponse).toEqual(responseEvent.rawResponse);
    });

    it('maps parentGenerationId as parent span linkage for generation spans', () => {
      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req-parent'] } as any);

      const responseWithParent = {
        ...responseEvent,
        parentGenerationId: 'gen-parent'
      } as any;

      const batch = compat.buildBatch([responseWithParent], mockManifest, { eventIds: ['event-resp-parent'] } as any);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);
      expect(spans[0]?.parentSpanIdHex).toBe(deriveOtlpSpanIdHex('gen-parent'));
    });

    it('uses trimmed metadata.step as the response span name when provided', () => {
      compat.buildBatch([requestEvent], mockManifest, { eventIds: ['event-req-step'] } as any);

      const steppedResponse = {
        ...responseEvent,
        metadata: {
          ...(responseEvent.metadata ?? {}),
          step: '  retrieval.phase  '
        }
      } as any;

      const batch = compat.buildBatch([steppedResponse], mockManifest, { eventIds: ['event-resp-step'] } as any);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe('retrieval.phase');
    });

    it('maps tool_execution events as spans with input/output and parent span linkage', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
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
        metadata: { correlationId: 'corr-123', batchId: 'batch-xyz' }
      };

      const batch = compat.buildBatch([{ ...toolEvent, type: 'tool_execution' } as any], mockManifest, { eventIds: ['event-tool'] } as any);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.parentSpanIdHex).toBe(deriveOtlpSpanIdHex(generationId));
      expect(span.startTimeIso).toBe('2024-01-01T00:00:00.450Z');
      expect(span.endTimeIso).toBe('2024-01-01T00:00:00.500Z');

      const attrs = span.attributes ?? {};
      expect(attrs['langfuse.observation.type']).toBe('span');
      expect(attrs['langfuse.trace.name']).toBe('batch-xyz');
      expect(attrs['llm.adapter.tool_name']).toBe('test.echo');
      expect(attrs['llm.adapter.tool_call_id']).toBe('call-1');

      const input = JSON.parse(String(attrs['langfuse.observation.input'] || '{}'));
      expect(input.toolName).toBe('test.echo');
      expect(input.args).toEqual({ text: 'hi' });

      const output = JSON.parse(String(attrs['langfuse.observation.output'] || '{}'));
      expect(output.resultText).toBe('ok');
      expect(output.result).toEqual({ ok: true });
    });

    it('maps tool_execution error/skipped variants and covers missing optional branches', () => {
      const toolError: any = {
        type: 'tool_execution',
        traceId: '' as any,
        generationId: undefined,
        timestampMs: 1704067200525,
        durationMs: '25',
        error: { message: 'boom' }
      };

      const errorBatch = compat.buildBatch([toolError], mockManifest, { eventIds: ['event-tool-error'] } as any);
      const errorSpans = (errorBatch.payload as any)?.spans ?? [];
      expect(errorSpans).toHaveLength(1);

      const errorSpan = errorSpans[0];
      expect(errorSpan.parentSpanIdHex).toBeUndefined();
      expect(errorSpan.name).toBe('llm.tool:tool');
      expect(errorSpan.spanIdHex).toBe(deriveOtlpSpanIdHex('event-tool-error'));
      expect(errorSpan.startTimeIso).toBe('2024-01-01T00:00:00.500Z');
      expect(errorSpan.endTimeIso).toBe('2024-01-01T00:00:00.525Z');
      expect(errorSpan.status).toEqual({ code: 'ERROR', message: 'boom' });

      const errorAttrs = errorSpan.attributes ?? {};
      expect(errorAttrs['llm.adapter.provider']).toBe('');
      expect(errorAttrs['llm.adapter.tool_name']).toBe('');
      expect(errorAttrs['llm.adapter.tool_call_id']).toBe('');
      expect(errorAttrs['llm.adapter.input_text']).toBe('');
      expect(errorAttrs['llm.adapter.output_text']).toBe('boom');
      expect(errorAttrs['langfuse.observation.level']).toBe('ERROR');
      expect(errorAttrs['langfuse.observation.status_message']).toBe('boom');

      const errorInput = JSON.parse(String(errorAttrs['langfuse.observation.input'] || '{}'));
      expect(errorInput).toEqual({ toolName: null, toolCallId: null });

      const errorOutput = JSON.parse(String(errorAttrs['langfuse.observation.output'] || '{}'));
      expect(errorOutput).toEqual({ error: { message: 'boom' } });

      const toolSkipped: any = {
        type: 'tool_execution',
        traceId,
        generationId: undefined,
        timestampMs: 1704067200600,
        durationMs: -1,
        skipped: true,
        skipReason: 'policy'
      };

      const skippedBatch = compat.buildBatch([toolSkipped], mockManifest, { eventIds: ['event-tool-skipped'] } as any);
      const skippedSpans = (skippedBatch.payload as any)?.spans ?? [];
      expect(skippedSpans).toHaveLength(1);

      const skippedSpan = skippedSpans[0];
      expect(skippedSpan.startTimeIso).toBe('2024-01-01T00:00:00.600Z');
      expect(skippedSpan.endTimeIso).toBe('2024-01-01T00:00:00.600Z');

      const skippedAttrs = skippedSpan.attributes ?? {};
      expect(skippedAttrs['llm.adapter.tool_skipped']).toBe(true);
      expect(skippedAttrs['llm.adapter.tool_skip_reason']).toBe('policy');
      expect(skippedAttrs['llm.adapter.output_text']).toBe('policy');
      expect(skippedAttrs['langfuse.observation.level']).toBe('WARNING');
      expect(skippedAttrs['langfuse.observation.status_message']).toBe('policy');

      const skippedOutput = JSON.parse(String(skippedAttrs['langfuse.observation.output'] || '{}'));
      expect(skippedOutput).toEqual({ skipped: true, skipReason: 'policy' });

      const toolEmpty: any = {
        type: 'tool_execution',
        traceId,
        generationId: undefined,
        timestampMs: 1704067200650,
        durationMs: 0
      };

      const emptyBatch = compat.buildBatch([toolEmpty], mockManifest, { eventIds: ['event-tool-empty'] } as any);
      const emptySpans = (emptyBatch.payload as any)?.spans ?? [];
      expect(emptySpans).toHaveLength(1);

      const emptyAttrs = emptySpans[0]?.attributes ?? {};
      expect(emptyAttrs['llm.adapter.output_text']).toBe('');
      expect(emptyAttrs['langfuse.observation.status_message']).toBeUndefined();

      const toolSkippedNoReason: any = {
        ...toolEmpty,
        skipped: true
      };

      const noReasonBatch = compat.buildBatch([toolSkippedNoReason], mockManifest, { eventIds: ['event-tool-no-reason'] } as any);
      const noReasonSpans = (noReasonBatch.payload as any)?.spans ?? [];
      expect(noReasonSpans).toHaveLength(1);

      const noReasonAttrs = noReasonSpans[0]?.attributes ?? {};
      expect(noReasonAttrs['llm.adapter.tool_skipped']).toBe(true);
      expect(noReasonAttrs['llm.adapter.tool_skip_reason']).toBeUndefined();
      expect(noReasonAttrs['llm.adapter.output_text']).toBe('');
      expect(noReasonAttrs['langfuse.observation.status_message']).toBeUndefined();

      const noReasonOutput = JSON.parse(String(noReasonAttrs['langfuse.observation.output'] || '{}'));
      expect(noReasonOutput).toEqual({ skipped: true });

      const toolErrorEmptyMessage: any = {
        type: 'tool_execution',
        traceId,
        generationId: undefined,
        timestampMs: 1704067200700,
        durationMs: 0,
        error: {}
      };

      const emptyMsgBatch = compat.buildBatch([toolErrorEmptyMessage], mockManifest, { eventIds: ['event-tool-error-empty'] } as any);
      const emptyMsgSpans = (emptyMsgBatch.payload as any)?.spans ?? [];
      expect(emptyMsgSpans).toHaveLength(1);
      expect(emptyMsgSpans[0]?.status).toEqual({ code: 'ERROR', message: 'error' });
    });

    it('maps signal events as langfuse events with level + output payload', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      compat.buildBatch([requestEvent], mockManifest, ctxReq);

      const signalEvent: ObservabilitySignalEvent = {
        traceId,
        generationId,
        sessionId: 'session-456',
        timestampMs: 1704067200600,
        level: 'warning',
        message: 'warn msg',
        source: 'tool_loop',
        code: 'tool_call_budget_exhausted',
        tags: ['t1'],
        metadata: { correlationId: 'corr-123', batchId: 'batch-xyz' }
      };

      const batch = compat.buildBatch([{ ...signalEvent, type: 'signal' } as any], mockManifest, { eventIds: ['event-signal'] } as any);
      const spans = (batch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.parentSpanIdHex).toBe(deriveOtlpSpanIdHex(generationId));
      expect(span.name).toBe('llm.telemetry.warning');
      const attrs = span.attributes ?? {};
      expect(attrs['langfuse.observation.type']).toBe('event');
      expect(attrs['langfuse.observation.level']).toBe('WARNING');
      expect(attrs['langfuse.observation.status_message']).toBe('warn msg');

      const output = JSON.parse(String(attrs['langfuse.observation.output'] || '{}'));
      expect(output.message).toBe('warn msg');
      expect(output.code).toBe('tool_call_budget_exhausted');
      expect(output.source).toBe('tool_loop');
    });

    it('maps signal events with error status and covers level normalization variants', () => {
      const signalErrorWithMessage: any = {
        type: 'signal',
        traceId,
        generationId: undefined,
        timestampMs: 1704067200700,
        level: 'error',
        message: 'boom'
      };

      const errorMsgBatch = compat.buildBatch([signalErrorWithMessage], mockManifest, { eventIds: ['event-signal-error-msg'] } as any);
      const errorMsgSpans = (errorMsgBatch.payload as any)?.spans ?? [];
      expect(errorMsgSpans).toHaveLength(1);

      const errorMsgSpan = errorMsgSpans[0];
      expect(errorMsgSpan.parentSpanIdHex).toBeUndefined();
      expect(errorMsgSpan.name).toBe('llm.telemetry.error');
      expect(errorMsgSpan.status).toEqual({ code: 'ERROR', message: 'boom' });
      expect(errorMsgSpan.attributes?.['langfuse.observation.level']).toBe('ERROR');
      expect(errorMsgSpan.attributes?.['langfuse.observation.status_message']).toBe('boom');

      const signalErrorNoMessage: any = {
        type: 'signal',
        traceId: '' as any,
        generationId: undefined,
        timestampMs: 1704067200701,
        level: 'error',
        message: '',
        stack: 'stack'
      };

      const errorNoMsgBatch = compat.buildBatch([signalErrorNoMessage], mockManifest, { eventIds: ['event-signal-error-empty'] } as any);
      const errorNoMsgSpans = (errorNoMsgBatch.payload as any)?.spans ?? [];
      expect(errorNoMsgSpans).toHaveLength(1);

      const errorNoMsgSpan = errorNoMsgSpans[0];
      expect(errorNoMsgSpan.name).toBe('llm.telemetry.error');
      expect(errorNoMsgSpan.status).toEqual({ code: 'ERROR', message: 'error' });

      const errorNoMsgAttrs = errorNoMsgSpan.attributes ?? {};
      expect(errorNoMsgAttrs['llm.adapter.trace_id']).toBe('');
      expect(errorNoMsgAttrs['langfuse.observation.status_message']).toBeUndefined();

      const errorNoMsgOutput = JSON.parse(String(errorNoMsgAttrs['langfuse.observation.output'] || '{}'));
      expect(errorNoMsgOutput).toEqual({ level: 'error', message: '', stack: 'stack' });

      const signalErrorUpperTrimmed: any = {
        type: 'signal',
        traceId,
        generationId,
        timestampMs: 17040672007015,
        level: ' Error ',
        message: 'upper error'
      };

      const errorUpperBatch = compat.buildBatch([signalErrorUpperTrimmed], mockManifest, { eventIds: ['event-signal-error-upper'] } as any);
      const errorUpperSpan = (errorUpperBatch.payload as any)?.spans?.[0];
      expect(errorUpperSpan.name).toBe('llm.telemetry.error');
      expect(errorUpperSpan.status).toEqual({ code: 'ERROR', message: 'upper error' });
      expect(errorUpperSpan.attributes?.['langfuse.observation.level']).toBe('ERROR');

      const signalDebug: any = {
        type: 'signal',
        traceId,
        generationId,
        timestampMs: 1704067200702,
        level: 'debug',
        message: 'dbg'
      };

      const debugBatch = compat.buildBatch([signalDebug], mockManifest, { eventIds: ['event-signal-debug'] } as any);
      const debugSpan = (debugBatch.payload as any)?.spans?.[0];
      const debugAttrs = debugSpan?.attributes ?? {};
      expect(debugSpan?.name).toBe('llm.telemetry.debug');
      expect(debugAttrs['langfuse.observation.level']).toBe('DEBUG');

      const signalWarn: any = {
        type: 'signal',
        traceId,
        generationId,
        timestampMs: 1704067200703,
        level: 'warn',
        message: 'warn'
      };

      const warnBatch = compat.buildBatch([signalWarn], mockManifest, { eventIds: ['event-signal-warn'] } as any);
      const warnSpan = (warnBatch.payload as any)?.spans?.[0];
      const warnAttrs = warnSpan?.attributes ?? {};
      expect(warnSpan?.name).toBe('llm.telemetry.warning');
      expect(warnAttrs['langfuse.observation.level']).toBe('WARNING');

      const signalInfo: any = {
        type: 'signal',
        traceId,
        generationId,
        timestampMs: 17040672007035,
        level: 'info',
        message: 'info'
      };

      const infoBatch = compat.buildBatch([signalInfo], mockManifest, { eventIds: ['event-signal-info'] } as any);
      const infoSpan = (infoBatch.payload as any)?.spans?.[0];
      const infoAttrs = infoSpan?.attributes ?? {};
      expect(infoSpan?.name).toBe('llm.telemetry.signal');
      expect(infoAttrs['langfuse.observation.level']).toBe('DEFAULT');

      const signalNonString: any = {
        type: 'signal',
        traceId,
        generationId,
        timestampMs: 1704067200704,
        level: 123,
        message: 'x'
      };

      const nonStringBatch = compat.buildBatch([signalNonString], mockManifest, { eventIds: ['event-signal-non-string'] } as any);
      const nonStringSpan = (nonStringBatch.payload as any)?.spans?.[0];
      const nonStringAttrs = nonStringSpan?.attributes ?? {};
      expect(nonStringSpan?.name).toBe('llm.telemetry.signal');
      expect(nonStringAttrs['langfuse.observation.level']).toBe('DEFAULT');
    });

    it('maps trace_update events and applies updates to subsequent spans', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;
      compat.buildBatch([requestEvent], mockManifest, ctxReq);

      const updateEvent: ObservabilityTraceUpdateEvent = {
        traceId,
        generationId,
        sessionId: 'session-456',
        timestampMs: 1704067200700,
        name: 'corr-updated',
        tags: ['t2', 't3'],
        metadata: { foo: 'bar' }
      };

      const updateBatch = compat.buildBatch([{ ...updateEvent, type: 'trace_update' } as any], mockManifest, { eventIds: ['event-update'] } as any);
      const updateSpans = (updateBatch.payload as any)?.spans ?? [];
      expect(updateSpans).toHaveLength(1);
      expect(updateSpans[0].name).toBe('llm.telemetry.event');
      expect(updateSpans[0].attributes?.['langfuse.trace.name']).toBe('batch-xyz');
      expect(updateSpans[0].attributes?.['llm.adapter.correlation_id']).toBe('corr-updated');

      const respBatch = compat.buildBatch([responseEvent], mockManifest, ctxResp);
      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);
      const attrs = spans[0]?.attributes ?? {};
      expect(attrs['langfuse.trace.name']).toBe('batch-xyz');
      expect(attrs['llm.adapter.correlation_id']).toBe('corr-updated');
      expect(attrs['langfuse.trace.tags']).toEqual(['t2', 't3']);
    });

    it('applies trace_update updates to cached summaries and supports no-op/empty updates', () => {
      const traceA = makeHexTraceId('aaaa');
      const traceB = makeHexTraceId('bbbb');

      const reqNoSession: any = {
        traceId: traceA,
        generationId: 'gen-a',
        timestampMs: 1704067200000,
        provider: 'provider-a',
        model: 'model-a',
        messages: []
      };

      const reqOther: any = {
        traceId: traceB,
        generationId: 'gen-b',
        sessionId: 'sess-b',
        timestampMs: 1704067200000,
        provider: 'provider-a',
        model: 'model-a',
        messages: []
      };

      compat.buildBatch([reqNoSession, reqOther], mockManifest, { eventIds: ['req-a', 'req-b'] } as any);

      const sessionOnlyUpdate: any = {
        type: 'trace_update',
        traceId: traceA,
        generationId: 'gen-a',
        sessionId: 'sess-new',
        timestampMs: 1704067200100
      };

      compat.buildBatch([sessionOnlyUpdate], mockManifest, { eventIds: ['update-session-only'] } as any);

      const cachedA = (compat as any).requestCache.get(`${traceA}:gen-a`);
      expect(cachedA.summary.sessionId).toBe('sess-new');

      const cachedB = (compat as any).requestCache.get(`${traceB}:gen-b`);
      expect(cachedB.summary.sessionId).toBe('sess-b');

      const tagsOnlyUpdate: any = {
        type: 'trace_update',
        traceId: traceA,
        generationId: 'gen-a',
        tags: [' t1 ', ''],
        timestampMs: 1704067200200
      };

      compat.buildBatch([tagsOnlyUpdate], mockManifest, { eventIds: ['update-tags-only'] } as any);
      expect((compat as any).requestCache.get(`${traceA}:gen-a`)?.summary?.tags).toEqual(['t1']);

      const noOpUpdate: any = {
        type: 'trace_update',
        traceId: traceA,
        generationId: 'gen-a',
        timestampMs: 1704067200300
      };

      compat.buildBatch([noOpUpdate], mockManifest, { eventIds: ['update-no-op'] } as any);

      const uncachedEmptyUpdate: any = {
        type: 'trace_update',
        traceId: '' as any,
        generationId: undefined,
        timestampMs: 1704067200400
      };

      const uncachedBatch = compat.buildBatch([uncachedEmptyUpdate], mockManifest, { eventIds: ['update-empty'] } as any);
      const uncachedSpans = (uncachedBatch.payload as any)?.spans ?? [];
      expect(uncachedSpans).toHaveLength(1);
      expect(uncachedSpans[0].name).toBe('llm.telemetry.event');

      const uncachedAttrs = uncachedSpans[0]?.attributes ?? {};
      expect(uncachedAttrs['langfuse.trace.metadata.payload']).toBeUndefined();
      expect(uncachedAttrs['langfuse.trace.name']).toBeUndefined();
    });

    it('parses ISO timestamps when timestampMs is missing (back-compat)', () => {
      const req: any = {
        traceId,
        generationId,
        timestamp: '2024-01-01T00:00:00.000Z',
        provider: 'provider-a',
        model: 'model-a',
        messages: []
      };

      compat.buildBatch([req], mockManifest, { eventIds: ['event-req'] } as any);
      const cached = (compat as any).requestCache.get(`${traceId}:${generationId}`);
      expect(cached.summary.startTimeIso).toBe('2024-01-01T00:00:00.000Z');
    });

    it('falls back to epoch timestamps when timestamps are missing/invalid', () => {
      const cases: any[] = [
        { timestamp: 123 },
        { timestamp: '   ' },
        { timestamp: 'not-a-date' },
        {}
      ];

      for (const extra of cases) {
        const resp: any = {
          traceId,
          generationId,
          provider: 'provider-a',
          model: 'model-a',
          content: [],
          ...extra
        };

        const batch = compat.buildBatch([resp], mockManifest, { eventIds: ['event-resp'] } as any);
        const spans = (batch.payload as any)?.spans ?? [];
        expect(spans).toHaveLength(1);
        expect(spans[0].startTimeIso).toBe('1970-01-01T00:00:00.000Z');
        expect(spans[0].endTimeIso).toBe('1970-01-01T00:00:00.000Z');
      }
    });

    it('truncates large attribute strings when maxAttributeValueBytes is provided', () => {
      const longText = 'x'.repeat(1000);

      const req: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        messages: [{ role: 'user', content: [{ type: 'text', text: longText }] }]
      };

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        content: [{ type: 'text', text: longText }]
      };

      compat.buildBatch([req], mockManifest, { eventIds: ['event-req'], maxAttributeValueBytes: 120 } as any);
      const respBatch = compat.buildBatch([resp], mockManifest, { eventIds: ['event-resp'], maxAttributeValueBytes: 120 } as any);

      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      const input = String(attrs['langfuse.observation.input'] ?? '');
      const output = String(attrs['langfuse.observation.output'] ?? '');

      expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(120);
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(120);
      expect(input.endsWith('…')).toBe(true);
      expect(output.endsWith('…')).toBe(true);
      expect(input.includes('\uFFFD')).toBe(false);
      expect(output.includes('\uFFFD')).toBe(false);
    });

    it('sets langfuse tags, maps usage_details (tokens only), and emits OTLP cost attributes', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const req: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        metadata: {
          ...requestEvent.metadata,
          tags: ['transport:cli', ' ', 42, 'provider:demo']
        }
      };

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          cached_tokens: 5,
          reasoning_tokens: 2,
          audio_tokens: 0,
          cost: 0.123,
          cost_details: { input: 0.01, output: 0.02, total: 999 }
        } as any
      };

      compat.buildBatch([req], mockManifest, ctxReq);
      const respBatch = compat.buildBatch([resp], mockManifest, ctxResp);

      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      expect(attrs['langfuse.trace.tags']).toEqual(['transport:cli', '42', 'provider:demo']);

      const usage = JSON.parse(String(attrs['langfuse.observation.usage_details'] || '{}'));
      expect(usage).toEqual({
        input: 10,
        output: 20,
        total: 30,
        cached_tokens: 5,
        reasoning_tokens: 2,
        audio_tokens: 0
      });

      expect(attrs['gen_ai.usage.cost']).toBe(0.123);
      const costDetails = JSON.parse(String(attrs['langfuse.observation.cost_details'] || '{}'));
      expect(costDetails).toEqual({ total: 0.123, input: 0.01, output: 0.02 });
    });

    it('ignores invalid cost breakdowns and still emits total cost attributes', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          cost: 0.5,
          costDetails: []
        } as any
      };

      compat.buildBatch([requestEvent], mockManifest, ctxReq);
      const respBatch = compat.buildBatch([resp], mockManifest, ctxResp);

      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      expect(attrs['gen_ai.usage.cost']).toBe(0.5);
      const costDetails = JSON.parse(String(attrs['langfuse.observation.cost_details'] || '{}'));
      expect(costDetails).toEqual({ total: 0.5 });
    });

    it('omits OTLP cost attributes when cost is missing', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const req: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        metadata: {
          ...requestEvent.metadata,
          tags: ['transport:cli']
        }
      };

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          cached_tokens: 5
        } as any
      };

      compat.buildBatch([req], mockManifest, ctxReq);
      const respBatch = compat.buildBatch([resp], mockManifest, ctxResp);

      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      expect(attrs['langfuse.observation.cost_details']).toBeUndefined();
      expect(attrs['gen_ai.usage.cost']).toBeUndefined();
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

      const span = spans[0];
      const attrs = span?.attributes ?? {};
      expect(attrs['llm.adapter.trace_id']).toBe(traceId);
      expect(attrs['llm.adapter.session_id']).toBe('session-456');
      expect(attrs['llm.adapter.correlation_id']).toBe('corr-123');
      expect(attrs['llm.adapter.batch_id']).toBe('batch-xyz');
    });

    it('omits blank correlationId and falls back batchId to sessionId', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const req: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        metadata: { correlationId: '   ', batchId: 123 as any }
      };

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        metadata: { correlationId: '   ', batchId: 123 as any }
      };

      compat.buildBatch([req], mockManifest, ctxReq);
      const respBatch = compat.buildBatch([resp], mockManifest, ctxResp);
      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      expect(attrs['llm.adapter.correlation_id']).toBeUndefined();
      expect(attrs['langfuse.trace.name']).toBe('session-456');
      expect(attrs['llm.adapter.batch_id']).toBe('session-456');
    });

    it('ignores non-finite usage values and ignores empty tags arrays', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      const req: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        metadata: {
          ...requestEvent.metadata,
          tags: ['   ', '']
        }
      };

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        usage: { input: Number.POSITIVE_INFINITY, output: 2, cost: Number.POSITIVE_INFINITY } as any
      };

      compat.buildBatch([req], mockManifest, ctxReq);
      const respBatch = compat.buildBatch([resp], mockManifest, ctxResp);
      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      expect(attrs['langfuse.trace.tags']).toBeUndefined();
      expect(attrs['langfuse.observation.cost_details']).toBeUndefined();
      expect(attrs['gen_ai.usage.cost']).toBeUndefined();

      const usage = JSON.parse(String(attrs['langfuse.observation.usage_details'] || '{}'));
      expect(usage).toEqual({ output: 2, total: 2 });
    });

    it('computes usage_details.total when output tokens are missing', () => {
      const ctxReq = { eventIds: ['event-req'] } as any;
      const ctxResp = { eventIds: ['event-resp'] } as any;

      compat.buildBatch([requestEvent], mockManifest, ctxReq);

      const resp: ObservabilityLLMResponseEvent = {
        ...responseEvent,
        usage: { input: 7 } as any
      };

      const respBatch = compat.buildBatch([resp], mockManifest, ctxResp);
      const spans = (respBatch.payload as any)?.spans ?? [];
      expect(spans).toHaveLength(1);

      const attrs = spans[0]?.attributes ?? {};
      const usage = JSON.parse(String(attrs['langfuse.observation.usage_details'] || '{}'));
      expect(usage).toEqual({ input: 7, total: 7 });
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

    it('bounds the request cache with LRU eviction and stores compact summaries', () => {
      const cache = (compat as any).requestCache;
      cache.setMaxEntries(2);

      const req1: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        traceId: makeHexTraceId('aaaa'),
        generationId: 'gen-1'
      };
      const req2: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        traceId: makeHexTraceId('bbbb'),
        generationId: 'gen-2'
      };
      const req3: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        traceId: makeHexTraceId('cccc'),
        generationId: 'gen-3'
      };

      compat.buildBatch([req1], mockManifest, { eventIds: ['req-1'], maxAttributeValueBytes: 1024 } as any);
      compat.buildBatch([req2], mockManifest, { eventIds: ['req-2'], maxAttributeValueBytes: 1024 } as any);
      compat.buildBatch([req3], mockManifest, { eventIds: ['req-3'], maxAttributeValueBytes: 1024 } as any);

      expect(cache.size).toBe(2);
      expect(cache.has(`${req1.traceId}:${req1.generationId}`)).toBe(false);

      const cached = cache.get(`${req3.traceId}:${req3.generationId}`);
      expect(cached).toBeDefined();
      expect(typeof cached.summary?.startTimeIso).toBe('string');
      // Should not retain full request event trees.
      expect(cached.summary?.event).toBeUndefined();
      expect(cached.summary?.messages).toBeUndefined();
    });

    it('caches empty provider/model as empty strings', () => {
      const req: ObservabilityLLMRequestEvent = {
        ...requestEvent,
        traceId: makeHexTraceId('empty'),
        generationId: 'gen-empty',
        provider: '' as any,
        model: '' as any
      };

      compat.buildBatch([req], mockManifest, { eventIds: ['event-req'], maxAttributeValueBytes: 1024 } as any);
      const cached = (compat as any).requestCache.get(`${req.traceId}:${req.generationId}`);
      expect(cached.summary.provider).toBe('');
      expect(cached.summary.model).toBe('');
    });

	    it('falls back to response timestamp when durationMs is missing and model can be empty', () => {
	      const resp: ObservabilityLLMResponseEvent = {
	        traceId: '' as any,
	        generationId: undefined,
	        timestamp: '2024-01-01T00:00:01.000Z',
	        timestampMs: 1704067201000,
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
	        timestampMs: 1704067200000,
	        provider: 'provider-a',
	        model: 'req-model',
	        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
	      };

	      const resp: ObservabilityLLMResponseEvent = {
	        traceId,
	        generationId,
	        timestamp: '2024-01-01T00:00:01.000Z',
	        timestampMs: 1704067201000,
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
	        timestampMs: 1704067200000,
	        provider: 'provider-a',
	        model: 'm',
	        messages: [],
	        settings: BigInt(1) as any
	      };

	      const resp: ObservabilityLLMResponseEvent = {
	        traceId,
	        generationId,
	        timestamp: '2024-01-01T00:00:01.000Z',
	        timestampMs: 1704067201000,
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

    it('blocks baseUrl override when allow env var is set but allowlist is missing (non-live)', async () => {
      process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE = '1';
      delete process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST;

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
      expect(fetchCall?.[0]).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    });

    it('treats empty allowlist entries as missing allowlist (blocks override in non-live)', async () => {
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
      expect(fetchCall?.[0]).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
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
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = '127.0.0.1';

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
      process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST = '127.0.0.1';

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
