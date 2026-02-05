import { jest } from '@jest/globals';

describe('modules/observability multi-target exporter', () => {
  test('routes events by target export configuration', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const tracesOnly: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 't1', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: 't2', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: 't3', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: 't4', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 't5', queued: true })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const signalsOnly: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 's1', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: 's2', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: 's3', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: 's4', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 's5', queued: true })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([
      {
        provider: 'traces',
        exporter: tracesOnly,
        export: { traces: true, tools: false, signals: false, traceUpdates: false }
      },
      {
        provider: 'signals',
        exporter: signalsOnly,
        export: { traces: false, tools: false, signals: true, traceUpdates: false }
      }
    ]);

    exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    exporter.recordLLMResponse({
      type: 'llm_response',
      traceId: 'trace-1',
      timestampMs: 1704067200100,
      provider: 'test',
      model: 'test',
      content: []
    } as any);

    const toolResult = exporter.recordToolExecution({
      type: 'tool_execution',
      traceId: 'trace-1',
      timestampMs: 1704067200200,
      toolCallId: 'call-1',
      toolName: 'tool',
      durationMs: 1
    } as any);

    exporter.recordSignal({
      type: 'signal',
      traceId: 'trace-1',
      timestampMs: 1704067201000,
      level: 'error',
      message: 'boom',
      source: 'adapter'
    } as any);

    const traceUpdateResult = exporter.recordTraceUpdate({
      type: 'trace_update',
      traceId: 'trace-1',
      timestampMs: 1704067200400,
      name: 'new-name'
    } as any);

    expect(tracesOnly.recordLLMRequest).toHaveBeenCalledTimes(1);
    expect(signalsOnly.recordLLMRequest).toHaveBeenCalledTimes(0);

    expect(tracesOnly.recordLLMResponse).toHaveBeenCalledTimes(1);
    expect(signalsOnly.recordLLMResponse).toHaveBeenCalledTimes(0);

    expect(tracesOnly.recordToolExecution).toHaveBeenCalledTimes(0);
    expect(signalsOnly.recordToolExecution).toHaveBeenCalledTimes(0);
    expect(toolResult).toEqual({ eventId: '', queued: false, reason: 'disabled' });

    expect(tracesOnly.recordSignal).toHaveBeenCalledTimes(0);
    expect(signalsOnly.recordSignal).toHaveBeenCalledTimes(1);

    expect(tracesOnly.recordTraceUpdate).toHaveBeenCalledTimes(0);
    expect(signalsOnly.recordTraceUpdate).toHaveBeenCalledTimes(0);
    expect(traceUpdateResult).toEqual({ eventId: '', queued: false, reason: 'disabled' });

    await exporter.flush();
    expect(tracesOnly.flush).toHaveBeenCalledTimes(1);
    expect(signalsOnly.flush).toHaveBeenCalledTimes(1);

    await exporter.shutdown();
    expect(tracesOnly.shutdown).toHaveBeenCalledTimes(1);
    expect(signalsOnly.shutdown).toHaveBeenCalledTimes(1);
  });

  test('filters invalid targets and defaults export config to all enabled', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const exporterImpl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: '1', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: '2', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: '3', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: '4', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: '5', queued: true })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([
      // invalid provider should be filtered
      { provider: '   ', exporter: exporterImpl, export: { traces: true } as any },
      // missing provider should be filtered (also exercises provider normalization fallback)
      { provider: undefined as any, exporter: exporterImpl },
      // missing export config defaults to all true
      { provider: 'ok', exporter: exporterImpl }
    ]);

    exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    exporter.recordLLMResponse({
      type: 'llm_response',
      traceId: 'trace-1',
      timestampMs: 1704067200100,
      provider: 'test',
      model: 'test',
      content: []
    } as any);

    exporter.recordToolExecution({
      type: 'tool_execution',
      traceId: 'trace-1',
      timestampMs: 1704067200200,
      toolCallId: 'call-1',
      toolName: 'tool',
      durationMs: 1
    } as any);

    exporter.recordSignal({
      type: 'signal',
      traceId: 'trace-1',
      timestampMs: 1704067200300,
      level: 'info',
      message: 'ok',
      source: 'client'
    } as any);

    exporter.recordTraceUpdate({
      type: 'trace_update',
      traceId: 'trace-1',
      timestampMs: 1704067200400,
      name: 'new-name'
    } as any);

    expect(exporterImpl.recordLLMRequest).toHaveBeenCalledTimes(1);
    expect(exporterImpl.recordLLMResponse).toHaveBeenCalledTimes(1);
    expect(exporterImpl.recordToolExecution).toHaveBeenCalledTimes(1);
    expect(exporterImpl.recordSignal).toHaveBeenCalledTimes(1);
    expect(exporterImpl.recordTraceUpdate).toHaveBeenCalledTimes(1);
  });

  test('preserves non-disabled record reasons when nothing is queued', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const shuttingDown: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 'sd-1', queued: false, reason: 'shutdown' })),
      recordLLMResponse: jest.fn(() => ({ eventId: 'sd-2', queued: false, reason: 'shutdown' })),
      recordToolExecution: jest.fn(() => ({ eventId: 'sd-3', queued: false, reason: 'shutdown' })),
      recordSignal: jest.fn(() => ({ eventId: 'sd-4', queued: false, reason: 'shutdown' })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 'sd-5', queued: false, reason: 'shutdown' })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const disabled: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 'd-1', queued: false, reason: 'disabled' })),
      recordLLMResponse: jest.fn(() => ({ eventId: 'd-2', queued: false, reason: 'disabled' })),
      recordToolExecution: jest.fn(() => ({ eventId: 'd-3', queued: false, reason: 'disabled' })),
      recordSignal: jest.fn(() => ({ eventId: 'd-4', queued: false, reason: 'disabled' })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 'd-5', queued: false, reason: 'disabled' })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([
      { provider: 'a', exporter: disabled, export: { traces: true } as any },
      { provider: 'b', exporter: shuttingDown, export: { traces: true } as any }
    ]);

    const result = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    expect(result).toEqual({ eventId: 'sd-1', queued: false, reason: 'shutdown' });
  });

  test('dedupes record calls when multiple targets share the same exporter instance', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 'x', queued: true })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([
      { provider: 'a', exporter: impl, export: { traces: true } as any },
      { provider: 'b', exporter: impl, export: { traces: true } as any }
    ]);

    const result = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    expect(result).toEqual({ eventId: 'x', queued: true });
    expect(impl.recordLLMRequest).toHaveBeenCalledTimes(1);
  });

  test('merges export config when de-duping shared exporter instances', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 'x', queued: true })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([
      {
        provider: 'a',
        exporter: impl,
        export: { traces: false, tools: false, signals: false, traceUpdates: false } as any
      },
      {
        provider: 'b',
        exporter: impl,
        export: { traces: true, tools: true, signals: true, traceUpdates: true } as any
      }
    ]);

    exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    exporter.recordSignal({
      type: 'signal',
      traceId: 'trace-1',
      timestampMs: 1704067201000,
      level: 'error',
      message: 'boom',
      source: 'adapter'
    } as any);

    expect(impl.recordLLMRequest).toHaveBeenCalledTimes(1);
    expect(impl.recordSignal).toHaveBeenCalledTimes(1);
  });

  test('returns the exporter result when nothing is queued (including disabled reasons)', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: '', queued: false, reason: 'disabled' })),
      recordLLMResponse: jest.fn(() => ({ eventId: '', queued: false, reason: 'disabled' })),
      recordToolExecution: jest.fn(() => ({ eventId: '', queued: false, reason: 'disabled' })),
      recordSignal: jest.fn(() => ({ eventId: '', queued: false, reason: 'disabled' })),
      recordTraceUpdate: jest.fn(() => ({ eventId: '', queued: false, reason: 'disabled' })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([{ provider: 'p', exporter: impl }]);

    const result = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    expect(result).toEqual({ eventId: '', queued: false, reason: 'disabled' });
    expect(impl.recordLLMRequest).toHaveBeenCalledTimes(1);
  });

  test('falls back to disabled when results omit a reason', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: '', queued: false })),
      recordLLMResponse: jest.fn(() => ({ eventId: '', queued: false })),
      recordToolExecution: jest.fn(() => ({ eventId: '', queued: false })),
      recordSignal: jest.fn(() => ({ eventId: '', queued: false })),
      recordTraceUpdate: jest.fn(() => ({ eventId: '', queued: false })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([{ provider: 'p', exporter: impl }]);

    const result = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    expect(result).toEqual({ eventId: '', queued: false, reason: 'disabled' });
  });

  test('uses empty eventId when a queued result omits eventId', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ queued: true })),
      recordLLMResponse: jest.fn(() => ({ queued: false })),
      recordToolExecution: jest.fn(() => ({ queued: false })),
      recordSignal: jest.fn(() => ({ queued: false })),
      recordTraceUpdate: jest.fn(() => ({ queued: false })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([{ provider: 'p', exporter: impl }]);

    const result = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    expect(result).toEqual({ eventId: '', queued: true });
    expect(impl.recordLLMRequest).toHaveBeenCalledTimes(1);
  });

  test('returns disabled when no targets accept the event category', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 'x', queued: true })),
      flush: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {})
    };

    const exporter = new MultiObservabilityExporter([
      {
        provider: 'none',
        exporter: impl,
        export: { traces: false, tools: false, signals: false, traceUpdates: false }
      }
    ]);

    const result = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: 1704067200000,
      provider: 'test',
      model: 'test',
      messages: []
    } as any);

    expect(result.queued).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(impl.recordLLMRequest).toHaveBeenCalledTimes(0);
  });

  test('dedupes flush/shutdown and swallows exporter failures', async () => {
    const { MultiObservabilityExporter } = await import(
      '@/modules/observability/internal/exporter/internal/multi-exporter.ts'
    );

    const impl: any = {
      recordLLMRequest: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordLLMResponse: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordToolExecution: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordSignal: jest.fn(() => ({ eventId: 'x', queued: true })),
      recordTraceUpdate: jest.fn(() => ({ eventId: 'x', queued: true })),
      flush: jest.fn(async () => {
        throw new Error('flush failed');
      }),
      shutdown: jest.fn(async () => {
        throw new Error('shutdown failed');
      })
    };

    const exporter = new MultiObservabilityExporter([
      { provider: 'a', exporter: impl },
      { provider: 'b', exporter: impl }
    ]);

    await expect(exporter.flush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();

    // two targets share the same exporter instance -> de-duped calls
    expect(impl.flush).toHaveBeenCalledTimes(1);
    expect(impl.shutdown).toHaveBeenCalledTimes(1);
  });
});
