import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import type { SignalsProviderManifest } from '@/kernel/index.ts';
import { SentrySignalsCompat } from '@/plugins/signals-compat/sentry/internal/sentry.ts';
import defaultCompat from '@/plugins/signals-compat/sentry/index.ts';

const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

describe('SentrySignalsCompat (envelope)', () => {
  let compat: SentrySignalsCompat;
  let originalEnv: NodeJS.ProcessEnv;

  const mockManifest: SignalsProviderManifest = {
    id: 'sentry',
    compat: 'sentry',
    endpoint: {
      // Note: this compat treats urlTemplate as a DSN value.
      urlTemplate: 'https://publickey@o0.ingest.sentry.io/123',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope'
      }
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env.LLM_LIVE;
    compat = new SentrySignalsCompat();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exports a constructor as default (plugin registry compat loading)', () => {
    expect(typeof defaultCompat).toBe('function');
  });

  it('buildBatch creates one envelope per valid signal and maps envelopeId -> event index', () => {
    const signal: any = {
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1704067200000,
      level: 'error',
      message: 'boom',
      code: 'E_TEST',
      stack: 'stack',
      tags: { a: '1' },
      metadata: { correlationId: 'corr-123', batchId: 'batch-xyz', sessionId: 'session-1' }
    };

    const batch = compat.buildBatch([signal], mockManifest, { eventIds: ['event-1'] } as any);
    const payload = batch.payload as any;
    expect(Array.isArray(payload?.envelopes)).toBe(true);
    expect(payload.envelopes).toHaveLength(1);

    expect(payload.envelopes[0].envelopeId).toBe('event-1');
    expect(typeof payload.envelopes[0].body).toBe('string');

    const lines = String(payload.envelopes[0].body).split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const envelopeHeader = JSON.parse(lines[0]);
    expect(typeof envelopeHeader.event_id).toBe('string');

    const itemHeader = JSON.parse(lines[1]);
    expect(itemHeader.type).toBe('event');

    const event = JSON.parse(lines[2]);
    expect(event.level).toBe('error');
    expect(event.message).toBe('boom');
    expect(event.tags?.a).toBe('1');
    expect(event.tags?.['llm.adapter.trace_id']).toBe('trace-1');
    expect(event.tags?.['llm.adapter.generation_id']).toBe('gen-1');
    expect(event.tags?.['llm.adapter.code']).toBe('E_TEST');
    expect(event.extra?.correlationId).toBe('corr-123');
    expect(event.extra?.batchId).toBe('batch-xyz');
    expect(event.extra?.sessionId).toBe('session-1');

    expect(batch.eventIndexByEnvelopeId.get('event-1')).toBe(0);
  });

  it('buildBatch falls back to signal-{index} envelopeIds and uses stable 32-hex event_id when provided', () => {
    const signal: any = {
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1704067200000,
      level: 'info',
      message: 'ok',
      metadata: {}
    };

    const stableId = 'deadbeef'.padEnd(32, '0');
    const batch = compat.buildBatch([signal], mockManifest, { eventIds: [stableId] } as any);

    const payload = batch.payload as any;
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].envelopeId).toBe(stableId);

    const lines = String(payload.envelopes[0].body).split('\n').filter(Boolean);
    const envelopeHeader = JSON.parse(lines[0]);
    expect(envelopeHeader.event_id).toBe(stableId);

    const event = JSON.parse(lines[2]);
    expect(event.level).toBe('info');

    const fallback = compat.buildBatch([signal], mockManifest, {} as any);
    expect(fallback.payload.envelopes[0].envelopeId).toBe('signal-0');
  });

  it('buildBatch truncates large string fields using maxAttributeValueBytes', () => {
    const batch = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'warning',
          message: '0123456789',
          stack: '0123456789',
          metadata: { correlationId: '0123456789' }
        }
      ],
      mockManifest,
      { eventIds: ['evt'], maxAttributeValueBytes: 5 } as any
    );

    const payload = batch.payload as any;
    const body = String(payload.envelopes[0].body);
    const event = JSON.parse(body.split('\n').filter(Boolean)[2]);

    expect(event.level).toBe('warning');
    expect(String(event.message)).toBe('01…');
    expect(String(event.extra?.stack || '')).toBe('01…');
    expect(String(event.extra?.correlationId || '')).toBe('01…');
  });

  it('buildBatch uses message fallbacks, skips empty tag keys/values, and omits metadata when undefined', () => {
    const batch = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: '',
          code: 'E_FALLBACK',
          tags: { '': 'x', a: '', b: '  ', c: 'ok', d: undefined as any }
        },
        {
          traceId: 'trace-2',
          generationId: 'gen-2',
          timestampMs: 1704067200001,
          level: 'error',
          message: ''
        }
      ],
      mockManifest,
      { eventIds: ['e1', 'e2'] } as any
    );

    const payload = batch.payload as any;
    const first = JSON.parse(String(payload.envelopes[0].body).split('\n').filter(Boolean)[2]);
    expect(first.message).toBe('E_FALLBACK');
    expect(first.tags?.c).toBe('ok');
    expect(first.tags?.a).toBeUndefined();
    expect(first.tags?.b).toBeUndefined();
    expect(first.extra?.metadata).toBeUndefined();

    const second = JSON.parse(String(payload.envelopes[1].body).split('\n').filter(Boolean)[2]);
    expect(second.message).toBe('signal');
  });

  it('buildBatch ignores invalid shapes', () => {
    const batch = compat.buildBatch(
      ['nope', {}, { traceId: 't', generationId: 'g', level: 'error' }, { traceId: 't', generationId: 'g', timestampMs: NaN, level: 'error', message: 'x' }],
      mockManifest,
      { eventIds: ['a', 'b', 'c', 'd'] } as any
    );

    const payload = batch.payload as any;
    expect(payload.envelopes).toHaveLength(0);
  });

  it('sendBatch posts envelopes to the derived envelope endpoint and returns outcomes', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, { timeoutMs: 1000 } as any);
    expect(res.success).toBe(true);
    expect(res.outcomes).toEqual([{ envelopeId: 'event-send', success: true, status: 200 }]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as any;
    expect(call[0]).toBe('https://o0.ingest.sentry.io/api/123/envelope/');
    expect(String(call[1]?.headers?.['Content-Type'] || '')).toBe('application/x-sentry-envelope');
    expect(String(call[1]?.headers?.['X-Sentry-Auth'] || '')).toContain('sentry_key=publickey');
  });

  it('sendBatch works when manifest endpoint headers are undefined', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const manifestNoHeaders: SignalsProviderManifest = {
      ...mockManifest,
      endpoint: { ...mockManifest.endpoint, headers: undefined }
    };

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      manifestNoHeaders,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, manifestNoHeaders, {} as any);
    expect(res.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const headers = (mockFetch.mock.calls[0] as any)[1]?.headers ?? {};
    expect(String(headers['Content-Type'] || '')).toBe('application/x-sentry-envelope');
    expect(String(headers['X-Sentry-Auth'] || '')).toContain('sentry_key=publickey');
  });

  it('sendBatch returns early for empty envelopes', async () => {
    const emptyPayload = await compat.sendBatch({}, mockManifest, {} as any);
    expect(emptyPayload).toEqual({ success: true, outcomes: [] });

    const emptyEnvelopes = await compat.sendBatch({ envelopes: [] }, mockManifest, {} as any);
    expect(emptyEnvelopes).toEqual({ success: true, outcomes: [] });
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('sendBatch supports DSNs with a path prefix', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const manifestWithPath: SignalsProviderManifest = {
      ...mockManifest,
      endpoint: {
        ...mockManifest.endpoint,
        urlTemplate: 'https://public@self.hosted.example/sentry/456'
      }
    };

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      manifestWithPath,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, manifestWithPath, {} as any);
    expect(res.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as any;
    expect(call[0]).toBe('https://self.hosted.example/sentry/api/456/envelope/');
  });

  it('sendBatch treats non-string manifest urlTemplate values as missing DSN', async () => {
    const manifestWithBadTemplate: SignalsProviderManifest = {
      ...mockManifest,
      endpoint: {
        ...mockManifest.endpoint,
        urlTemplate: 123 as any
      }
    };

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      manifestWithBadTemplate,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, manifestWithBadTemplate, {} as any);
    expect(res.success).toBe(false);
    expect(res.outcomes[0].retryable).toBe(false);
    expect(String(res.outcomes[0].error || '')).toContain('DSN');
  });

  it('sendBatch prefers providerConfig.dsn over manifest urlTemplate', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const dsn = 'https://cfgkey@o1.ingest.sentry.io/999';
    const manifestMissingDsn: SignalsProviderManifest = {
      ...mockManifest,
      endpoint: { ...mockManifest.endpoint, urlTemplate: '' }
    };

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'debug',
          message: 'boom',
          metadata: {}
        }
      ],
      manifestMissingDsn,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, manifestMissingDsn, { providerConfig: { dsn } } as any);
    expect(res.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String((mockFetch.mock.calls[0] as any)[0])).toBe('https://o1.ingest.sentry.io/api/999/envelope/');
  });

  it('sendBatch includes sentry_secret when DSN includes a password', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const manifestWithSecret: SignalsProviderManifest = {
      ...mockManifest,
      endpoint: { ...mockManifest.endpoint, urlTemplate: 'https://pub:sec@o0.ingest.sentry.io/123' }
    };

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      manifestWithSecret,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, manifestWithSecret, {} as any);
    expect(res.success).toBe(true);
    const headers = (mockFetch.mock.calls[0] as any)[1]?.headers ?? {};
    expect(String(headers['X-Sentry-Auth'] || '')).toContain('sentry_secret=sec');
  });

  it('sendBatch marks 5xx responses as retryable failures', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Boom', headers: { get: () => null } } as any);

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, {} as any);
    expect(res.success).toBe(false);
    expect(res.outcomes[0]).toEqual({
      envelopeId: 'event-send',
      success: false,
      status: 500,
      error: 'HTTP 500: Boom',
      retryable: true
    });
  });

  it('sendBatch builds errorText without statusText when statusText is not a string', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: undefined, headers: { get: () => null } } as any);

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, {} as any);
    expect(res.success).toBe(false);
    expect(res.outcomes[0]).toEqual({
      envelopeId: 'event-send',
      success: false,
      status: 500,
      error: 'HTTP 500',
      retryable: true
    });
  });

  it('sendBatch marks 4xx responses as non-retryable failures', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad', headers: { get: () => null } } as any);

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, {} as any);
    expect(res.success).toBe(false);
    expect(res.outcomes[0]).toEqual({
      envelopeId: 'event-send',
      success: false,
      status: 400,
      error: 'HTTP 400: Bad',
      retryable: false
    });
  });

  it('sendBatch marks fetch errors as retryable failures', async () => {
    mockFetch.mockRejectedValue(new Error('network'));

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, { timeoutMs: 100 } as any);
    expect(res.success).toBe(false);
    expect(res.outcomes[0]).toEqual({
      envelopeId: 'event-send',
      success: false,
      error: 'Error: network',
      retryable: true
    });
  });

  it('sendBatch treats non-Error rejections as retryable failures (covers isAbortError branches)', async () => {
    mockFetch.mockRejectedValue({ code: 'NOPE' });

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, {} as any);
    expect(res.success).toBe(false);
    expect(res.outcomes[0]).toEqual({
      envelopeId: 'event-send',
      success: false,
      error: '[object Object]',
      retryable: true
    });
  });

  it('sendBatch handles 429 retry-after variants without throwing', async () => {
    const retryAfterValues: Array<string | null> = [
      new Date(Date.now() + 2000).toUTCString(),
      new Date(Date.now() - 1000).toUTCString(),
      null,
      '   ',
      '0.001',
      'wat'
    ];

    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many',
      headers: {
        get: (name: string) => (String(name).toLowerCase() === 'retry-after' ? retryAfterValues.shift() ?? null : null)
      }
    }) as any);

    const signals = Array.from({ length: 6 }, (_, i) => ({
      traceId: `trace-${i}`,
      generationId: `gen-${i}`,
      timestampMs: 1704067200000 + i,
      level: 'error',
      message: 'boom',
      metadata: {}
    }));

    const payload = compat.buildBatch(signals, mockManifest, { eventIds: ['a', 'b', 'c', 'd', 'e', 'f'] } as any).payload;
    const res = await compat.sendBatch(payload, mockManifest, {} as any);

    expect(res.success).toBe(false);
    expect(res.outcomes).toHaveLength(6);
    expect(res.outcomes.every(o => o.retryable === true)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('sendBatch triggers the internal timeout abort when fetch does not settle', async () => {
    mockFetch.mockImplementation(async (_url: any, init: any) => {
      const signal: AbortSignal | undefined = init?.signal;
      return await new Promise((_resolve, reject) => {
        const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) {
          reject(abortError);
          return;
        }
        signal?.addEventListener('abort', () => reject(abortError), { once: true });
      });
    });

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    await expect(compat.sendBatch(payload, mockManifest, { timeoutMs: 1 } as any)).rejects.toMatchObject({
      name: 'AbortError'
    });
  });

  it('sendBatch aborts in-flight fetch when the provided signal aborts', async () => {
    mockFetch.mockImplementation(async (_url: any, init: any) => {
      const signal: AbortSignal | undefined = init?.signal;
      return await new Promise((_resolve, reject) => {
        const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) {
          reject(abortError);
          return;
        }
        signal?.addEventListener('abort', () => reject(abortError), { once: true });
      });
    });

    const controller = new AbortController();
    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const promise = compat.sendBatch(payload, mockManifest, { signal: controller.signal } as any);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sendBatch returns non-retryable outcomes for invalid DSNs (parse errors and missing fields)', async () => {
    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const invalidUrl: SignalsProviderManifest = { ...mockManifest, endpoint: { ...mockManifest.endpoint, urlTemplate: 'not a url' } };
    const invalidRes = await compat.sendBatch(payload, invalidUrl, {} as any);
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.outcomes[0].retryable).toBe(false);
    expect(String(invalidRes.outcomes[0].error || '')).toContain('Invalid Sentry DSN');

    const missingKey: SignalsProviderManifest = { ...mockManifest, endpoint: { ...mockManifest.endpoint, urlTemplate: 'https://o0.ingest.sentry.io/123' } };
    const missingKeyRes = await compat.sendBatch(payload, missingKey, {} as any);
    expect(missingKeyRes.success).toBe(false);
    expect(missingKeyRes.outcomes[0].retryable).toBe(false);
    expect(String(missingKeyRes.outcomes[0].error || '')).toContain('missing public key');

    const missingProject: SignalsProviderManifest = { ...mockManifest, endpoint: { ...mockManifest.endpoint, urlTemplate: 'https://k@o0.ingest.sentry.io/' } };
    const missingProjectRes = await compat.sendBatch(payload, missingProject, {} as any);
    expect(missingProjectRes.success).toBe(false);
    expect(missingProjectRes.outcomes[0].retryable).toBe(false);
    expect(String(missingProjectRes.outcomes[0].error || '')).toContain('missing project id');
  });

  it('sendBatch throws AbortError when a shutdown signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    await expect(compat.sendBatch(payload, mockManifest, { signal: controller.signal } as any)).rejects.toMatchObject({
      name: 'AbortError'
    });
  });

  it('sendBatch treats AbortError fetch failures as aborts (no outcome returned)', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const controller = new AbortController();
    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    await expect(compat.sendBatch(payload, mockManifest, { signal: controller.signal } as any)).rejects.toMatchObject({
      name: 'AbortError'
    });
  });

  it('sendBatch supports context signals (abort listener wiring) without breaking success', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } } as any);

    const controller = new AbortController();
    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      mockManifest,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, mockManifest, { signal: controller.signal, timeoutMs: 100 } as any);
    expect(res.success).toBe(true);
  });

  it('sendBatch returns non-retryable outcomes when DSN is missing', async () => {
    const manifestMissingDsn: SignalsProviderManifest = {
      ...mockManifest,
      endpoint: {
        ...mockManifest.endpoint,
        urlTemplate: ''
      }
    };

    const payload = compat.buildBatch(
      [
        {
          traceId: 'trace-1',
          generationId: 'gen-1',
          timestampMs: 1704067200000,
          level: 'error',
          message: 'boom',
          metadata: {}
        }
      ],
      manifestMissingDsn,
      { eventIds: ['event-send'] } as any
    ).payload;

    const res = await compat.sendBatch(payload, manifestMissingDsn, {} as any);
    expect(res.success).toBe(false);
    expect(res.outcomes).toEqual([
      { envelopeId: 'event-send', success: false, error: expect.stringContaining('DSN'), retryable: false }
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });
});
