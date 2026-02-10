import { jest } from '@jest/globals';

describe('modules/observability/internal/telemetry-submit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('returns invalid_trace_id when traceId is empty/whitespace', async () => {
    await jest.isolateModulesAsync(async () => {
      const createObservabilityRuntime = jest.fn();
      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');

      const result = await submitTelemetry(
        {} as any,
        { type: 'signal', traceId: '   ', level: 'error', message: 'boom' } as any
      );

      expect(result).toEqual({
        traceId: '',
        eventId: '',
        queued: false,
        reason: 'invalid_trace_id'
      });
      expect(createObservabilityRuntime).not.toHaveBeenCalled();
    });
  });

  test('returns disabled when observability runtime is unavailable', async () => {
    await jest.isolateModulesAsync(async () => {
      const createObservabilityRuntime = jest.fn(async () => undefined);
      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');

      const result = await submitTelemetry(
        {} as any,
        { type: 'signal', traceId: 'trace_1', level: 'warning', message: 'test' } as any
      );

      expect(result).toEqual({
        traceId: 'trace_1',
        eventId: '',
        queued: false,
        reason: 'disabled'
      });
      expect(createObservabilityRuntime).toHaveBeenCalledTimes(1);
    });
  });

  test('records a signal and redacts metadata', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(9999);

      const recordSignal = jest.fn(() => ({ eventId: 'evt_1', queued: true }));
      const recordTraceUpdate = jest.fn();

      const createObservabilityRuntime = jest.fn(async () => ({
        exporter: { recordSignal, recordTraceUpdate },
        baseTraceId: 'trace_1',
        sessionId: 'sess_1'
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');

      const registry = {};
      const result = await submitTelemetry(
        registry as any,
        {
          type: 'signal',
          traceId: ' trace_1 ',
          generationId: ' gen_1 ',
          timestampMs: 1234.9,
          level: 'error',
          message: 'boom',
          tags: ['t1'],
          metadata: { apiKey: 'secret1234', nested: { accessToken: 'abcd' } },
          observability: { enabled: true, traceId: 'ignored' }
        } as any,
        { runtime: { batchId: 'b1' } }
      );

      expect(result).toEqual({ traceId: 'trace_1', eventId: 'evt_1', queued: true });
      expect(createObservabilityRuntime).toHaveBeenCalledWith(
        registry as any,
        expect.objectContaining({ enabled: true, traceId: 'trace_1' }),
        expect.objectContaining({ runtime: { batchId: 'b1' }, sessionIdFallback: 'batch' })
      );

      expect(recordSignal).toHaveBeenCalledTimes(1);
      const evt = recordSignal.mock.calls[0]?.[0] as any;
      expect(evt.traceId).toBe('trace_1');
      expect(evt.generationId).toBe('gen_1');
      expect(evt.sessionId).toBe('sess_1');
      expect(evt.timestampMs).toBe(1234);
      expect(evt.source).toBe('client');
      expect(evt.metadata.apiKey).toBe('***1234');
      expect(evt.metadata.nested.accessToken).toBe('***');
    });
  });

  test('records a trace_update event', async () => {
    await jest.isolateModulesAsync(async () => {
      const recordTraceUpdate = jest.fn(() => ({ eventId: 'evt_2', queued: true }));
      const recordSignal = jest.fn();

      const createObservabilityRuntime = jest.fn(async () => ({
        exporter: { recordSignal, recordTraceUpdate },
        baseTraceId: 'trace_2',
        sessionId: undefined
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');

      const result = await submitTelemetry(
        {} as any,
        { type: 'trace_update', traceId: 'trace_2', name: 'n1', tags: ['t'] } as any
      );

      expect(result).toEqual({ traceId: 'trace_2', eventId: 'evt_2', queued: true });
      expect(recordTraceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace_2',
          name: 'n1',
          tags: ['t']
        })
      );
    });
  });

  test('records a signal with explicit source/code/stack and omits empty fields', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(7777);

      const recordSignal = jest.fn(() => ({ eventId: 'evt_3', queued: true }));
      const recordTraceUpdate = jest.fn();

      const createObservabilityRuntime = jest.fn(async () => ({
        exporter: { recordSignal, recordTraceUpdate },
        baseTraceId: 'trace_3',
        sessionId: undefined
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');

      const registry = {};
      const result = await submitTelemetry(
        registry as any,
        {
          type: 'signal',
          traceId: 'trace_3',
          generationId: 123,
          timestampMs: Number.POSITIVE_INFINITY,
          level: 'info',
          message: 'hello',
          source: 'app',
          code: 'E_APP',
          stack: 'stacktrace',
          observability: 'not_an_object'
        } as any
      );

      expect(result).toEqual({ traceId: 'trace_3', eventId: 'evt_3', queued: true });
      expect(createObservabilityRuntime).toHaveBeenCalledWith(
        registry as any,
        expect.objectContaining({ traceId: 'trace_3' }),
        expect.objectContaining({ metadata: undefined, sessionIdFallback: 'batch' })
      );

      const evt = recordSignal.mock.calls[0]?.[0] as any;
      expect(evt.traceId).toBe('trace_3');
      expect(evt.generationId).toBeUndefined();
      expect(evt.sessionId).toBeUndefined();
      expect(evt.timestampMs).toBe(7777);
      expect(evt.source).toBe('app');
      expect(evt.code).toBe('E_APP');
      expect(evt.stack).toBe('stacktrace');
      expect(evt.tags).toBeUndefined();
      expect(evt.metadata).toBeUndefined();
    });
  });

  test('records a trace_update with sessionId, generationId, and redacted metadata', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(8888);

      const recordTraceUpdate = jest.fn(() => ({ eventId: 'evt_4', queued: true }));
      const recordSignal = jest.fn();

      const createObservabilityRuntime = jest.fn(async () => ({
        exporter: { recordSignal, recordTraceUpdate },
        baseTraceId: 'trace_4',
        sessionId: 'sess_4'
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');

      const result = await submitTelemetry(
        {} as any,
        {
          type: 'trace_update',
          traceId: 'trace_4',
          generationId: ' gen_4 ',
          level: 'debug',
          message: 'ignored',
          metadata: { access_token: 'token1234' },
          observability: { enabled: true }
        } as any
      );

      expect(result).toEqual({ traceId: 'trace_4', eventId: 'evt_4', queued: true });
      const evt = recordTraceUpdate.mock.calls[0]?.[0] as any;
      expect(evt.traceId).toBe('trace_4');
      expect(evt.generationId).toBe('gen_4');
      expect(evt.sessionId).toBe('sess_4');
      expect(evt.timestampMs).toBe(8888);
      expect(evt.name).toBeUndefined();
      expect(evt.tags).toBeUndefined();
      expect(evt.metadata.access_token).toBe('***1234');
    });
  });

  test('records full Core-like signal payload fields unchanged apart from normalization/redaction', async () => {
    await jest.isolateModulesAsync(async () => {
      const recordSignal = jest.fn(() => ({ eventId: 'evt_core_signal', queued: true }));
      const recordTraceUpdate = jest.fn();

      const createObservabilityRuntime = jest.fn(async () => ({
        exporter: { recordSignal, recordTraceUpdate },
        baseTraceId: 'trace_core_signal',
        sessionId: 'sess_core'
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');
      const registry = {};

      const payload: any = {
        type: 'signal',
        traceId: ' trace_core_signal ',
        generationId: ' gen_core_123 ',
        timestampMs: 1739060000000.9,
        level: 'warning',
        message: 'tool fallback used',
        source: 'llm_adapter_client',
        code: 'tool_call_budget_exhausted',
        tags: ['subassistant'],
        metadata: {
          assistant: 'inventory',
          apiKey: 'secret1234'
        },
        observability: {
          enabled: true,
          traceId: 'ignored',
          targets: [{ provider: 'obs-a', export: { signals: true } }]
        }
      };

      const result = await submitTelemetry(registry as any, payload);
      expect(result).toEqual({ traceId: 'trace_core_signal', eventId: 'evt_core_signal', queued: true });

      expect(createObservabilityRuntime).toHaveBeenCalledWith(
        registry as any,
        expect.objectContaining({
          enabled: true,
          traceId: 'trace_core_signal',
          targets: [{ provider: 'obs-a', export: { signals: true } }]
        }),
        expect.objectContaining({ sessionIdFallback: 'batch' })
      );

      const event = recordSignal.mock.calls[0]?.[0] as any;
      expect(event.traceId).toBe('trace_core_signal');
      expect(event.generationId).toBe('gen_core_123');
      expect(event.sessionId).toBe('sess_core');
      expect(event.timestampMs).toBe(1739060000000);
      expect(event.level).toBe('warning');
      expect(event.message).toBe('tool fallback used');
      expect(event.source).toBe('llm_adapter_client');
      expect(event.code).toBe('tool_call_budget_exhausted');
      expect(event.tags).toEqual(['subassistant']);
      expect(event.metadata.assistant).toBe('inventory');
      expect(event.metadata.apiKey).toBe('***1234');
    });
  });

  test('records full Core-like trace_update payload fields unchanged apart from normalization/redaction', async () => {
    await jest.isolateModulesAsync(async () => {
      const recordTraceUpdate = jest.fn(() => ({ eventId: 'evt_core_update', queued: true }));
      const recordSignal = jest.fn();

      const createObservabilityRuntime = jest.fn(async () => ({
        exporter: { recordSignal, recordTraceUpdate },
        baseTraceId: 'trace_core_update',
        sessionId: 'sess_core_update'
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/runtime.js', () => ({
        createObservabilityRuntime
      }));

      const { submitTelemetry } = await import('@/modules/observability/index.ts');
      const registry = {};

      const payload: any = {
        type: 'trace_update',
        traceId: ' trace_core_update ',
        generationId: ' gen_core_456 ',
        timestampMs: 1739060001000.9,
        tags: ['subassistant', 'fn_inventory_search'],
        metadata: {
          source: 'llm_adapter_client',
          step: 'subassistant',
          accessToken: 'abcd'
        },
        observability: {
          enabled: true,
          traceId: 'ignored',
          targets: [{ provider: 'obs-a', export: { traceUpdates: true } }]
        }
      };

      const result = await submitTelemetry(registry as any, payload);
      expect(result).toEqual({ traceId: 'trace_core_update', eventId: 'evt_core_update', queued: true });

      expect(createObservabilityRuntime).toHaveBeenCalledWith(
        registry as any,
        expect.objectContaining({
          enabled: true,
          traceId: 'trace_core_update',
          targets: [{ provider: 'obs-a', export: { traceUpdates: true } }]
        }),
        expect.objectContaining({ sessionIdFallback: 'batch' })
      );

      const event = recordTraceUpdate.mock.calls[0]?.[0] as any;
      expect(event.traceId).toBe('trace_core_update');
      expect(event.generationId).toBe('gen_core_456');
      expect(event.sessionId).toBe('sess_core_update');
      expect(event.timestampMs).toBe(1739060001000);
      expect(event.tags).toEqual(['subassistant', 'fn_inventory_search']);
      expect(event.metadata.source).toBe('llm_adapter_client');
      expect(event.metadata.step).toBe('subassistant');
      expect(event.metadata.accessToken).toBe('***');
    });
  });
});
