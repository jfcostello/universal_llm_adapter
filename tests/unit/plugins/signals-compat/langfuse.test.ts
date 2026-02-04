import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import type { SignalsProviderManifest } from '@/kernel/index.ts';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '@/modules/observability/index.ts';
import { LangfuseSignalsCompat } from '@/plugins/signals-compat/langfuse/internal/langfuse.ts';
import defaultCompat from '@/plugins/signals-compat/langfuse/index.ts';

const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

function makeHexTraceId(seed: string): string {
  return seed.padEnd(32, '0').slice(0, 32);
}

describe('LangfuseSignalsCompat (OTLP)', () => {
  let compat: LangfuseSignalsCompat;
  let originalEnv: NodeJS.ProcessEnv;

  const traceId = makeHexTraceId('deadbeef');
  const generationId = 'gen-abc';

  const mockManifest: SignalsProviderManifest = {
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

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-456';
    delete process.env.LLM_LIVE;
    delete process.env.LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE;
    delete process.env.LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST;

    compat = new LangfuseSignalsCompat();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exports a constructor as default (plugin registry compat loading)', () => {
    expect(typeof defaultCompat).toBe('function');
  });

  it('buildBatch maps an ERROR signal as an event observation span', () => {
    const signal: any = {
      traceId,
      generationId,
      timestampMs: 1704067200000,
      level: 'error',
      message: 'boom',
      code: 'E_TEST',
      stack: 'stack',
      tags: { a: '1' },
      metadata: { correlationId: 'corr-123', batchId: 'batch-xyz', sessionId: 'session-1', tags: ['t1'] }
    };

    const batch = compat.buildBatch([signal], mockManifest, { eventIds: ['event-1'] } as any);
    const spans = (batch.payload as any)?.spans ?? [];
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.traceIdHex).toBe(deriveOtlpTraceIdHex(traceId));
    expect(span.spanIdHex).toBe(deriveOtlpSpanIdHex('event-1'));
    expect(span.parentSpanIdHex).toBe(deriveOtlpSpanIdHex(generationId));
    expect(span.status).toEqual({ code: 'ERROR', message: 'boom' });

    const attrs = span.attributes ?? {};
    expect(attrs['langfuse.observation.type']).toBe('event');
    expect(attrs['langfuse.observation.level']).toBe('ERROR');
    expect(attrs['langfuse.observation.status_message']).toBe('boom');
    expect(attrs['langfuse.trace.name']).toBe('corr-123');
    expect(attrs['langfuse.session.id']).toBe('session-1');
    expect(attrs['langfuse.trace.tags']).toEqual(['t1']);
    expect(attrs['llm.adapter.trace_id']).toBe(traceId);
    expect(attrs['llm.adapter.correlation_id']).toBe('corr-123');
    expect(attrs['llm.adapter.batch_id']).toBe('batch-xyz');

    expect(batch.eventIndexByEnvelopeId.get('event-1')).toBe(0);
  });

  it('buildBatch maps WARNING/DEBUG/DEFAULT levels and truncates status_message', () => {
    const base: any = {
      traceId,
      timestampMs: 1704067200000,
      message: '0123456789',
      metadata: {}
    };

    const batch = compat.buildBatch(
      [
        { ...base, generationId, level: 'warning' },
        { ...base, generationId, level: 'debug' },
        { ...base, generationId, level: 'info' }
      ],
      mockManifest,
      { eventIds: ['w', 'd', 'i'], maxAttributeValueBytes: 5 } as any
    );

    const spans = (batch.payload as any)?.spans ?? [];
    expect(spans).toHaveLength(3);
    expect(spans[0].attributes?.['langfuse.observation.level']).toBe('WARNING');
    expect(spans[0].status).toEqual({ code: 'OK' });
    expect(String(spans[0].attributes?.['langfuse.observation.status_message'] || '')).toBe('01234');
    expect(spans[1].attributes?.['langfuse.observation.level']).toBe('DEBUG');
    expect(spans[2].attributes?.['langfuse.observation.level']).toBe('DEFAULT');
  });

  it('buildBatch ignores invalid shapes and supports missing parent spanId', () => {
    const validNoParent: any = {
      traceId,
      generationId: '',
      timestampMs: 1704067200000,
      level: 'error',
      message: '',
      metadata: {}
    };

    const batch = compat.buildBatch(
      ['nope', {}, { traceId, generationId, message: 'x', level: 'error' }, { ...validNoParent, timestampMs: Number.NaN }, validNoParent],
      mockManifest,
      { eventIds: ['a', 'b', 'c', 'd'], maxAttributeValueBytes: 0 } as any
    );

    const spans = (batch.payload as any)?.spans ?? [];
    expect(spans).toHaveLength(1);
    expect(spans[0].parentSpanIdHex).toBeUndefined();
    expect(spans[0].status).toEqual({ code: 'ERROR', message: 'error' });
  });

  it('sendBatch returns early for empty spans and posts OTLP for non-empty', async () => {
    const emptyPayload = await compat.sendBatch({}, mockManifest, {} as any);
    expect(emptyPayload).toEqual({ success: true, outcomes: [] });

    const empty = await compat.sendBatch({ spans: [] }, mockManifest, {} as any);
    expect(empty).toEqual({ success: true, outcomes: [] });

    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const payload = compat.buildBatch(
      [
        {
          traceId,
          generationId,
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const manifestNoHeaders = {
      ...mockManifest,
      endpoint: {
        ...mockManifest.endpoint,
        headers: undefined
      }
    } as any;

    const res = await compat.sendBatch(payload, manifestNoHeaders, { timeoutMs: 1000 } as any);
    expect(res.success).toBe(true);
    expect(res.outcomes).toEqual([{ envelopeId: 'event-send', success: true, status: 200 }]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as any;
    expect(call[0]).toBe(mockManifest.endpoint.urlTemplate);
    expect(call[1]?.headers?.Authorization).toContain('Basic ');
  });
});
