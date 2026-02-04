import { describe, expect, jest, test } from '@jest/globals';

import type { SignalsSpec } from '@/kernel/index.ts';
import { ToolCallBudget } from '@/modules/tools/index.ts';
import { createToolFailureSignalReporter } from '@/modules/tools/internal/tool-loop/internal/tool-failure-signals.ts';
import { executeNonStreamToolCallsRound } from '@/modules/tools/internal/tool-loop/internal/nonstream-execute.ts';
import { executeStreamToolCallsRound } from '@/modules/tools/internal/tool-loop/internal/stream-execute.ts';

const providerManifest: any = {
  id: 'provider',
  compat: 'mock'
};

const createLoggerStub = () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}) as any;

function createObservabilityStub(): any {
  return {
    exporter: {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      recordToolExecution: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined)
    },
    traceId: 'trace-123',
    sessionId: 'session-456',
    metadata: { correlationId: 'corr-789' },
    captureMessages: 'text',
    captureToolArgs: true,
    captureRequestPayload: true,
    captureRawResponse: true,
    sampleRate: 1,
    maxInputTextBytes: 4096,
    maxOutputTextBytes: 4096,
    maxJsonBytes: 8192
  };
}

describe('tools/tool-failure-signals', () => {
  test('createToolFailureSignalReporter no-ops when signals disabled', async () => {
    const getSignalsDeps = jest.fn();
    const logger = createLoggerStub();

    const report = createToolFailureSignalReporter({
      registry: {} as any,
      spec: { enabled: false } as any,
      logger,
      getSignalsDeps: getSignalsDeps as any
    });

    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'boom'
    });

    expect(getSignalsDeps).not.toHaveBeenCalled();
  });

  test('createToolFailureSignalReporter no-ops when enabled but no targets are configured', async () => {
    const getSignalsDeps = jest.fn();
    const logger = createLoggerStub();

    const report = createToolFailureSignalReporter({
      registry: {} as any,
      spec: { enabled: true, targets: [] } as any,
      logger,
      getSignalsDeps: getSignalsDeps as any
    });

    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'boom'
    });

    expect(getSignalsDeps).not.toHaveBeenCalled();
  });

  test('createToolFailureSignalReporter records and caches signals deps', async () => {
    const recordSignal = jest.fn();
    const deps: any = {
      isEnabled: () => true,
      getExporter: () => ({ recordSignal }),
      shutdown: async () => {}
    };
    const getSignalsDeps = jest.fn().mockResolvedValue(deps);

    const logger = createLoggerStub();
    const spec: SignalsSpec = {
      enabled: true,
      targets: [{ provider: 'test-provider' }]
    };

    const report = createToolFailureSignalReporter({
      registry: {} as any,
      spec,
      logger,
      getSignalsDeps: getSignalsDeps as any
    });

    await report({
      traceId: '',
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'skip'
    });
    await report({
      traceId: undefined,
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'skip'
    });
    await report({
      traceId: 'trace-1',
      generationId: '',
      timestampMs: 1,
      level: 'error',
      message: 'skip'
    });
    await report({
      traceId: 'trace-1',
      generationId: undefined,
      timestampMs: 1,
      level: 'error',
      message: 'skip'
    });

    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 123,
      level: 'error',
      message: 'boom',
      code: 'tool_execution_failed',
      stack: 'stack',
      metadata: { toolName: 'tool_a', toolCallId: 'call-1' }
    });

    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(999);
    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: Number.NaN,
      level: 'error',
      message: 'boom2'
    });
    dateNowSpy.mockRestore();

    expect(getSignalsDeps).toHaveBeenCalledTimes(1);
    expect(recordSignal).toHaveBeenCalledTimes(2);
    expect(recordSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-1',
        generationId: 'gen-1',
        timestampMs: 123,
        level: 'error',
        message: 'boom',
        code: 'tool_execution_failed',
        stack: 'stack',
        metadata: { toolName: 'tool_a', toolCallId: 'call-1' }
      })
    );
    expect(recordSignal.mock.calls[1]?.[0]?.timestampMs).toBe(999);
  });

  test('createToolFailureSignalReporter uses real signals deps when not injected (and remains best-effort)', async () => {
    const logger = createLoggerStub();
    const spec: SignalsSpec = {
      enabled: true,
      targets: [{ provider: 'unknown-provider' }]
    };

    const report = createToolFailureSignalReporter({
      registry: {} as any,
      spec,
      logger
    });

    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'boom'
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'Signals target failed to initialize',
      expect.objectContaining({ provider: 'unknown-provider' })
    );
  });

  test('createToolFailureSignalReporter logs and swallows deps init failures', async () => {
    const logger = createLoggerStub();
    const getSignalsDeps = jest.fn().mockRejectedValue('nope');

    const report = createToolFailureSignalReporter({
      registry: {} as any,
      spec: { enabled: true, targets: [{ provider: 'test-provider' }] } as any,
      logger,
      getSignalsDeps: getSignalsDeps as any
    });

    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'boom'
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'signals.tool_failure_report_failed',
      expect.objectContaining({ error: 'nope' })
    );
  });

  test('createToolFailureSignalReporter logs and swallows exporter failures', async () => {
    const logger = createLoggerStub();
    const recordSignal = jest.fn(() => {
      throw new Error('bad export');
    });
    const deps: any = {
      isEnabled: () => true,
      getExporter: () => ({ recordSignal }),
      shutdown: async () => {}
    };
    const getSignalsDeps = jest.fn().mockResolvedValue(deps);

    const report = createToolFailureSignalReporter({
      registry: {} as any,
      spec: { enabled: true, targets: [{ provider: 'test-provider' }] } as any,
      logger,
      getSignalsDeps: getSignalsDeps as any
    });

    await report({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1,
      level: 'error',
      message: 'boom'
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'signals.tool_failure_report_failed',
      expect.objectContaining({ error: 'bad export' })
    );
  });

  test('non-stream tool execution failures invoke reportToolFailureSignal', async () => {
    const reportToolFailureSignal = jest.fn().mockResolvedValue(undefined);

    await executeNonStreamToolCallsRound({
      toolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }] as any,
      toolNameMap: {},
      toolByName: new Map([['tool_a', { name: 'tool_a' }]]) as any,
      toolBudget: new ToolCallBudget(1),
      toolCountdownEnabled: false,
      parallelExecution: false,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      messages: [],
      invokeTool: async () => {
        throw new Error('boom');
      },
      observability: createObservabilityStub(),
      generationId: 'gen-1',
      reportToolFailureSignal
    } as any);

    expect(reportToolFailureSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        generationId: 'gen-1',
        level: 'error',
        code: 'tool_execution_failed'
      })
    );
    expect(String((reportToolFailureSignal.mock.calls[0] as any)[0]?.message || '')).toContain('tool_a');
    expect(String((reportToolFailureSignal.mock.calls[0] as any)[0]?.message || '')).toContain('boom');
  });

  test('non-stream tool-budget exhaustion invokes reportToolFailureSignal', async () => {
    const reportToolFailureSignal = jest.fn().mockResolvedValue(undefined);

    await executeNonStreamToolCallsRound({
      toolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }] as any,
      toolNameMap: {},
      toolByName: new Map([['tool_a', { name: 'tool_a' }]]) as any,
      toolBudget: new ToolCallBudget(0),
      toolCountdownEnabled: false,
      parallelExecution: false,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      messages: [],
      invokeTool: async () => ({ result: null }),
      observability: createObservabilityStub(),
      generationId: 'gen-1',
      reportToolFailureSignal
    } as any);

    expect(reportToolFailureSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        generationId: 'gen-1',
        level: 'error',
        code: 'tool_call_budget_exhausted'
      })
    );
  });

  test('stream tool execution failures invoke reportToolFailureSignal', async () => {
    const reportToolFailureSignal = jest.fn().mockResolvedValue(undefined);

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool_a', arguments: {} }] as any,
      toolCallReasoning: undefined,
      messages: [],
      tools: [{ name: 'tool_a' }] as any,
      toolNameMap: {},
      toolByName: new Map([['tool_a', { name: 'tool_a' }]]) as any,
      budget: new ToolCallBudget(1),
      toolCountdownEnabled: false,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool: async () => {
        throw new Error('boom');
      },
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all',
      observability: createObservabilityStub(),
      generationId: 'gen-1',
      reportToolFailureSignal
    } as any);

    for await (const _event of gen) {
      // drain
    }

    expect(reportToolFailureSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        generationId: 'gen-1',
        level: 'error',
        code: 'tool_execution_failed'
      })
    );
  });

  test('stream tool-budget exhaustion invokes reportToolFailureSignal', async () => {
    const reportToolFailureSignal = jest.fn().mockResolvedValue(undefined);

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool_a', arguments: {} }] as any,
      toolCallReasoning: undefined,
      messages: [],
      tools: [{ name: 'tool_a' }] as any,
      toolNameMap: {},
      toolByName: new Map([['tool_a', { name: 'tool_a' }]]) as any,
      budget: new ToolCallBudget(0),
      toolCountdownEnabled: false,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool: async () => ({ result: null }),
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all',
      observability: createObservabilityStub(),
      generationId: 'gen-1',
      reportToolFailureSignal
    } as any);

    for await (const _event of gen) {
      // drain
    }

    expect(reportToolFailureSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        generationId: 'gen-1',
        level: 'error',
        code: 'tool_call_budget_exhausted'
      })
    );
  });
});
