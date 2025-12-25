import { describe, expect, jest, test } from '@jest/globals';

const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
if (!unstableMockModule) {
  throw new Error('jest.unstable_mockModule is required for this test suite');
}

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

  test('sendOtlpTraceSpans respects Retry-After (seconds) on 429 responses', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn(async () => {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          get: (key: string) => (key.toLowerCase() === 'retry-after' ? '1' : null)
        }
      } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    let resolved = false;
    const promise = sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    }).then(result => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    jest.advanceTimersByTime(1000);
    await expect(promise).resolves.toMatchObject({
      success: false,
      outcomes: [{ envelopeId: 'env-1', success: false, status: 429, retryable: true }]
    });

    jest.useRealTimers();
  });

  test('sendOtlpTraceSpans respects Retry-After (http-date) on 429 responses', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const retryAfter = new Date(Date.now() + 1000).toUTCString();
    const fetchMock = jest.fn(async () => {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          get: (key: string) => (key.toLowerCase() === 'retry-after' ? retryAfter : null)
        }
      } as any;
    });
    (globalThis as any).fetch = fetchMock;

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    let resolved = false;
    const promise = sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    }).then(result => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    jest.advanceTimersByTime(1000);
    await expect(promise).resolves.toMatchObject({ success: false });

    jest.useRealTimers();
  });

  test('sendOtlpTraceSpans ignores invalid Retry-After values on 429 responses', async () => {
    jest.useFakeTimers();
    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');

    for (const headerValue of [' ', 'abc', '-1', '0']) {
      const fetchMock = jest.fn(async () => {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            get: () => headerValue
          }
        } as any;
      });
      (globalThis as any).fetch = fetchMock;

      const promise = sendOtlpTraceSpans({
        spans: [makeSpan('env-1')],
        url: 'http://example.com',
        headers: {}
      });

      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(0);
      await expect(promise).resolves.toMatchObject({ success: false });
    }

    jest.useRealTimers();
  });

  test('sendOtlpTraceSpans can use an encode worker when enabled', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    let workerConstructed = 0;
    let onlineEmitted = false;

    class MockWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        workerConstructed += 1;
        setImmediate(() => {
          onlineEmitted = true;
          this.emit('online');
        });
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(message: any) {
        const { id } = message;
        const response = {
          id,
          ok: true,
          chunks: [{ envelopeIds: ['env-1'], body: new Uint8Array([1, 2, 3]), oversize: false }]
        };
        setImmediate(() => {
          // Spurious messages should be ignored.
          this.emit('message', { ok: true, chunks: [] });
          this.emit('message', { id: 999, ok: true, chunks: [] });
          this.emit('message', response);
        });
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: MockWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');

    const result1 = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });
    expect(result1.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init1 = fetchMock.mock.calls[0][1] as any;
    expect(init1.body).toBeInstanceOf(Uint8Array);
    expect((init1.body as Uint8Array).byteLength).toBe(3);

    // Second call should reuse the same worker.
    const result2 = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });
    expect(result2.success).toBe(true);
    expect(workerConstructed).toBe(1);
    expect(onlineEmitted).toBe(true);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans can hit the default worker decision path', async () => {
    const previousFlag = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    const previousJestWorkerId = process.env.JEST_WORKER_ID;

    delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.JEST_WORKER_ID = '';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    let constructed = 0;
    class WorkerConstructionFails {
      constructor() {
        constructed += 1;
        throw new Error('worker construction failed');
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: WorkerConstructionFails }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(constructed).toBeLessThanOrEqual(1);

    if (previousFlag === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previousFlag;
    }

    if (previousJestWorkerId === undefined) {
      delete process.env.JEST_WORKER_ID;
    } else {
      process.env.JEST_WORKER_ID = previousJestWorkerId;
    }
  });

  test('sendOtlpTraceSpans treats worker ok:true responses without chunks as an empty chunk list', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class NoChunksWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('online'));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(message: any) {
        const { id } = message;
        setImmediate(() => this.emit('message', { id, ok: true, chunks: null }));
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: NoChunksWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result).toEqual({ success: true, outcomes: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back when worker returns ok:false with an error', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class OkFalseWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('online'));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(message: any) {
        const { id } = message;
        setImmediate(() => this.emit('message', { id, ok: false, error: 'boom' }));
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: OkFalseWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back when worker returns ok:false without an error', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class OkFalseNoErrorWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('online'));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(message: any) {
        const { id } = message;
        setImmediate(() => this.emit('message', { id, ok: false }));
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: OkFalseNoErrorWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back when worker exits before becoming ready', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class ExitBeforeOnlineWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('exit', 2));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(_message: any) {}
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: ExitBeforeOnlineWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back when worker errors before becoming ready', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class ErrorBeforeOnlineWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('error', new Error('init error')));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(_message: any) {}
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: ErrorBeforeOnlineWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back when worker postMessage throws', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class PostMessageThrowsWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('online'));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {}

      postMessage(_message: any) {
        throw new Error('postMessage threw');
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: PostMessageThrowsWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back to sync encoding when worker construction fails and honors worker disable flag', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    unstableMockModule('node:worker_threads', () => ({
      Worker: class {
        constructor() {
          throw new Error('no-worker');
        }
      }
    }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');

    // First call falls back due to worker failure.
    const result1 = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });
    expect(result1.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call should short-circuit worker startup via the disabled flag, and still succeed.
    const result2 = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });
    expect(result2.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans ignores worker usage when explicitly disabled via env var', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '0';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    unstableMockModule('node:worker_threads', () => ({
      Worker: class {
        constructor() {
          throw new Error('worker should not be constructed');
        }
      }
    }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
  });

  test('sendOtlpTraceSpans falls back when worker errors and terminate throws', async () => {
    const previous = process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = '1';

    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).fetch = fetchMock;

    class ErrorWorker {
      private listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        setImmediate(() => this.emit('online'));
      }

      unref() {}

      on(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return this;
      }

      once(event: string, handler: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
          this.off(event, wrapped);
          handler(...args);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: (...args: any[]) => void) {
        const set = this.listeners.get(event);
        set?.delete(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of Array.from(set)) {
          handler(...args);
        }
      }

      terminate() {
        throw new Error('terminate failed');
      }

      postMessage(_message: any) {
        setImmediate(() => this.emit('error', new Error('worker error')));
      }
    }

    unstableMockModule('node:worker_threads', () => ({ Worker: ErrorWorker }));

    const { sendOtlpTraceSpans } = await import('@/modules/observability/internal/otlp/client.ts');
    const result = await sendOtlpTraceSpans({
      spans: [makeSpan('env-1')],
      url: 'http://example.com',
      headers: {}
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (previous === undefined) {
      delete process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER;
    } else {
      process.env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER = previous;
    }
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

    await Promise.resolve();
    await Promise.resolve();
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
