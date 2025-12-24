import { describe, expect, jest, test } from '@jest/globals';

function makeSpan(envelopeId?: string) {
  return {
    traceIdHex: '0123456789abcdef0123456789abcdef',
    spanIdHex: '0123456789abcdef',
    name: 'llm.generation',
    startTimeIso: '2024-01-01T00:00:00.000Z',
    endTimeIso: '2024-01-01T00:00:01.000Z',
    attributes: {
      'langfuse.observation.model.name': 'model-a',
      'langfuse.observation.input': '{"messages":["hi"]}',
      'langfuse.observation.output': '{"content":["ok"]}'
    },
    ...(envelopeId ? { envelopeId } : {})
  };
}

describe('modules/observability OTLP client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.resetModules();
    (globalThis as any).fetch = originalFetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  test('sendOtlpTraceSpans returns success for empty spans', async () => {
    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: null as any,
      url: 'http://example.com',
      headers: undefined as any
    } as any);
    expect(result).toEqual({ success: true, outcomes: [] });
  });

  test('sendOtlpTraceSpans marks oversize spans as non-retryable and does not call fetch', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('fetch should not be called');
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {},
      maxBatchBytes: 1
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.outcomes).toEqual([
      {
        envelopeId: 'env-1',
        success: false,
        error: expect.stringContaining('maxBatchBytes'),
        retryable: false
      }
    ]);
  });

  test('sendOtlpTraceSpans splits oversized multi-span requests into multiple POSTs', async () => {
    const { encodeOtlpTraceRequest } = await import('@/modules/observability/internal/otlp/encode.ts');
    const one = makeSpan('env-1');
    const two = { ...makeSpan('env-2'), spanIdHex: 'ffffffffffffffff' };

    const oneBytes = encodeOtlpTraceRequest([one]).byteLength;
    const twoBytes = encodeOtlpTraceRequest([one, two]).byteLength;
    expect(twoBytes).toBeGreaterThan(oneBytes);

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [one, two],
      url: 'http://example.com',
      headers: { 'Content-Type': 'application/x-protobuf' },
      maxBatchBytes: oneBytes
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.outcomes).toEqual([
      { envelopeId: 'env-1', success: true, status: 200 },
      { envelopeId: 'env-2', success: true, status: 200 }
    ]);
  });

  test('sendOtlpTraceSpans reports retryable HTTP failures with statusText', async () => {
    const fetchMock = jest.fn(async () => {
      return { ok: false, status: 503, statusText: 'Service Unavailable' } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {},
      timeoutMs: 1
    });

    expect(result.success).toBe(false);
    expect(result.outcomes[0]).toMatchObject({
      envelopeId: 'env-1',
      success: false,
      status: 503,
      error: 'HTTP 503: Service Unavailable',
      retryable: true
    });
  });

  test('sendOtlpTraceSpans reports non-retryable HTTP failures without statusText', async () => {
    const fetchMock = jest.fn(async () => {
      return { ok: false, status: 400 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {},
      timeoutMs: -1,
      maxBatchBytes: -1
    });

    expect(result.success).toBe(false);
    expect(result.outcomes[0]).toMatchObject({
      envelopeId: 'env-1',
      success: false,
      status: 400,
      error: 'HTTP 400',
      retryable: false
    });
  });

  test('sendOtlpTraceSpans treats 429s as retryable', async () => {
    const fetchMock = jest.fn(async () => {
      return { ok: false, status: 429, statusText: 'Too Many Requests' } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(false);
    expect(result.outcomes[0]).toMatchObject({ retryable: true, status: 429 });
  });

  test('sendOtlpTraceSpans treats thrown errors as retryable', async () => {
    const fetchMock = jest.fn(async () => {
      throw 'boom-string';
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(false);
    expect(result.outcomes[0]).toMatchObject({
      envelopeId: 'env-1',
      success: false,
      error: 'boom-string',
      retryable: true
    });
  });

  test('sendOtlpTraceSpans aborts requests on timeout', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn((_url: any, init: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')));
      });
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');

    const promise = sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {},
      timeoutMs: 5
    });

    jest.advanceTimersByTime(10);
    await expect(promise).resolves.toMatchObject({
      success: false,
      outcomes: [{ envelopeId: 'env-1', success: false, error: 'aborted', retryable: true }]
    });

    jest.useRealTimers();
  });

  test('sendOtlpTraceSpans succeeds even when spans do not include envelope ids', async () => {
    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 204 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan()],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(result.outcomes).toEqual([]);
  });
});
