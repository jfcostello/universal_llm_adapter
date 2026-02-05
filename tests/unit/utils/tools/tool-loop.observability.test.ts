import { describe, expect, jest, test } from '@jest/globals';
import { runToolLoop } from '@/modules/tools/index.ts';
import { Role } from '@/kernel/index.ts';
import { recordToolExecutionObservability, recordToolFailureSignal } from '@/modules/tools/internal/tool-loop/internal/observability.ts';

const providerManifest: any = {
  id: 'provider',
  compat: 'mock'
};

function createObservabilityContext(overrides: Partial<Record<string, any>> = {}) {
  return {
    exporter: {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      recordToolExecution: jest.fn(),
      recordSignal: jest.fn(),
      recordTraceUpdate: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined)
    },
    traceId: 'trace-123',
    sessionId: 'session-456',
    metadata: { correlationId: 'corr-789' },
    captureMessages: 'full',
    captureToolArgs: true,
    captureRequestPayload: false,
    captureRawResponse: false,
    sampleRate: 1,
    maxInputTextBytes: 4096,
    maxOutputTextBytes: 4096,
    maxJsonBytes: 8192,
    ...overrides
  };
}

describe('utils/tools/runToolLoop observability', () => {
  test('records a tool execution event on non-stream success', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { value: 42 } });
    const observability = createObservabilityContext();

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: { correlationId: 'corr-789' },
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { answer: true } }]
      } as any,
      invokeTool
    });

    expect(observability.exporter.recordToolExecution).toHaveBeenCalledTimes(1);
    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event).toEqual(
      expect.objectContaining({
        traceId: 'trace-123',
        sessionId: 'session-456',
        provider: 'provider',
        model: 'model',
        toolCallId: 'call-1',
        toolName: 'example_tool',
        args: { answer: true },
        result: { value: 42 },
        resultText: '{"value":42}'
      })
    );
    expect(typeof event.timestampMs).toBe('number');

    expect(observability.exporter.recordSignal).not.toHaveBeenCalled();
  });

  test('captureMessages="none" omits tool result fields but still records execution metadata', async () => {
    const llmManager: any = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: []
      }),
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });
    const observability = createObservabilityContext({ captureMessages: 'none' });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { answer: true } }]
      } as any,
      invokeTool
    });

    expect(observability.exporter.recordToolExecution).toHaveBeenCalledTimes(1);
    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event.result).toBeUndefined();
    expect(event.resultText).toBeUndefined();
    expect(event.args).toEqual({ answer: true });
  });

  test('records a tool error signal and tool execution error details when invocation throws', async () => {
    const llmManager: any = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: []
      }),
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockRejectedValue(new Error('boom'));
    const observability = createObservabilityContext();

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', args: { answer: true } }]
      } as any,
      invokeTool
    });

    expect(observability.exporter.recordToolExecution).toHaveBeenCalledTimes(1);
    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event.error).toEqual(expect.objectContaining({ message: 'boom', code: 'tool_execution_failed' }));
    expect(event.resultText).toContain('boom');

    expect(observability.exporter.recordSignal).toHaveBeenCalledTimes(1);
    const signal = (observability.exporter.recordSignal as any).mock.calls[0][0];
    expect(signal).toEqual(
      expect.objectContaining({
        traceId: 'trace-123',
        sessionId: 'session-456',
        level: 'error',
        code: 'tool_execution_failed'
      })
    );
  });

  test('records a skipped tool execution + warning signal when tool budget is exhausted', async () => {
    const llmManager: any = {
      callProvider: jest.fn(),
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn();
    const observability = createObservabilityContext();

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 0
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { answer: true } }]
      } as any,
      invokeTool
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(observability.exporter.recordToolExecution).toHaveBeenCalledTimes(1);
    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event).toEqual(
      expect.objectContaining({
        toolCallId: 'call-1',
        toolName: 'example_tool',
        skipped: true,
        skipReason: 'tool_call_budget_exhausted'
      })
    );

    expect(observability.exporter.recordSignal).toHaveBeenCalledTimes(1);
    const signal = (observability.exporter.recordSignal as any).mock.calls[0][0];
    expect(signal).toEqual(expect.objectContaining({ level: 'warning', code: 'tool_call_budget_exhausted' }));
  });

  test('stream loop includes runContext.generationId on tool execution events when provided', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { text: 'done' };
      })
    };

    const registry: any = {
      getCompatModule: jest.fn().mockResolvedValue({ parseStreamChunk: (chunk: any) => chunk })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: 'ok' });
    const observability = createObservabilityContext();

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        maxToolIterations: 1,
        toolCountdownEnabled: 'false',
        preserveToolResults: 'all',
        preserveReasoning: 'all'
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability, generationId: 'gen-1' },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'example_tool', args: { x: 1 } }] as any,
      invokeTool
    });

    for await (const _event of iterator) {
      // Drain
    }

    expect(observability.exporter.recordToolExecution).toHaveBeenCalledTimes(1);
    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event).toEqual(
      expect.objectContaining({
        traceId: 'trace-123',
        generationId: 'gen-1',
        toolCallId: 'call-1',
        toolName: 'example_tool',
        args: { x: 1 },
        result: 'ok',
        resultText: 'ok'
      })
    );
  });

  test('respects maxJsonBytes<=0 and maxOutputTextBytes non-finite by omitting structured fields and emptying resultText', async () => {
    const llmManager: any = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: []
      }),
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { value: 42 } });
    const observability = createObservabilityContext({
      maxJsonBytes: 0,
      maxOutputTextBytes: Number.NaN
    });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { answer: true } }]
      } as any,
      invokeTool
    });

    expect(observability.exporter.recordToolExecution).toHaveBeenCalledTimes(1);
    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event.args).toBeUndefined();
    expect(event.result).toBeUndefined();
    expect(event.resultText).toBe('');
  });

  test('truncates tool resultText using runtime.toolResultMaxChars', async () => {
    const llmManager: any = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: []
      }),
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: 'abcdefghijklmnopqrstuvwxyz' });
    const observability = createObservabilityContext();

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 1,
        toolResultMaxChars: 3
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { answer: true } }]
      } as any,
      invokeTool
    });

    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event.resultText).toBe('abc…');
    expect(event.result).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  test('does not truncate tool resultText when maxResultLength is larger than the result', async () => {
    const llmManager: any = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: []
      }),
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: 'ok' });
    const observability = createObservabilityContext();

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: 1,
        toolResultMaxChars: 100
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { answer: true } }]
      } as any,
      invokeTool
    });

    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event.resultText).toBe('ok');
  });

  test('stream tool failures emit signals with generationId and omit sessionId/metadata when absent', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { text: 'done' };
      })
    };

    const registry: any = {
      getCompatModule: jest.fn().mockResolvedValue({ parseStreamChunk: (chunk: any) => chunk })
    };

    const invokeTool = jest.fn().mockRejectedValue(new Error('boom'));
    const observability: any = createObservabilityContext({
      sessionId: undefined,
      metadata: undefined,
      captureMessages: undefined,
      captureToolArgs: undefined,
      maxJsonBytes: undefined,
      maxOutputTextBytes: undefined
    });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        maxToolIterations: 1,
        toolCountdownEnabled: 'false',
        preserveToolResults: 'all',
        preserveReasoning: 'all'
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability, generationId: 'gen-1' },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { x: 1 } }] as any,
      invokeTool
    });

    for await (const _event of iterator) {
      // Drain
    }

    const toolEvent = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(toolEvent.generationId).toBe('gen-1');
    expect(toolEvent.sessionId).toBeUndefined();

    expect(observability.exporter.recordSignal).toHaveBeenCalledTimes(1);
    const signal = (observability.exporter.recordSignal as any).mock.calls[0][0];
    expect(signal.generationId).toBe('gen-1');
    expect(signal.sessionId).toBeUndefined();
    expect(signal.metadata?.tool).toEqual(
      expect.objectContaining({
        name: 'example_tool',
        callId: 'call-1'
      })
    );
  });

  test('whitespace generationId in runContext is ignored', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { text: 'done' };
      })
    };

    const registry: any = {
      getCompatModule: jest.fn().mockResolvedValue({ parseStreamChunk: (chunk: any) => chunk })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: 'ok' });
    const observability = createObservabilityContext();

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        maxToolIterations: 1,
        toolCountdownEnabled: 'false',
        preserveToolResults: 'all',
        preserveReasoning: 'all'
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { observability, generationId: '   ' },
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { x: 1 } }] as any,
      invokeTool
    });

    for await (const _event of iterator) {
      // Drain
    }

    const event = (observability.exporter.recordToolExecution as any).mock.calls[0][0];
    expect(event.generationId).toBeUndefined();
  });

  test('swallows exporter failures in tool observability helpers and logs warnings (Error vs string)', () => {
    const logger: any = { warning: jest.fn() };

    const obs: any = {
      exporter: {
        recordToolExecution: jest.fn(() => { throw new Error('boom'); }),
        recordSignal: jest.fn(() => { throw new Error('signal-boom'); })
      },
      traceId: 'trace-1',
      captureMessages: 'full',
      captureToolArgs: true,
      sampleRate: 1,
      maxInputTextBytes: 4096,
      maxOutputTextBytes: 4096,
      maxJsonBytes: 8192
    };

    recordToolExecutionObservability({
      observability: obs,
      logger,
      generationId: undefined,
      provider: 'provider',
      model: 'model',
      toolCallId: 'call-1',
      toolName: 'tool',
      timestampMs: Date.now(),
      args: { a: 1 },
      result: { ok: true },
      maxResultLength: -1
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to record observability tool execution event',
      expect.objectContaining({ error: 'boom' })
    );

    // Force the `?? String(e)` path.
    obs.exporter.recordToolExecution.mockImplementationOnce(() => { throw 'string-boom'; });
    recordToolExecutionObservability({
      observability: obs,
      logger,
      generationId: undefined,
      provider: 'provider',
      model: 'model',
      toolCallId: 'call-2',
      toolName: 'tool',
      timestampMs: Date.now(),
      args: { a: 1 },
      result: { ok: true },
      maxResultLength: -1
    });
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to record observability tool execution event',
      expect.objectContaining({ error: 'string-boom' })
    );

    recordToolFailureSignal({
      observability: obs,
      logger,
      generationId: undefined,
      timestampMs: Date.now(),
      level: 'warning',
      code: 'tool_call_budget_exhausted',
      message: 'warn',
      toolCallId: 'call-1',
      toolName: 'tool',
      provider: 'provider',
      model: 'model'
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to record observability signal event',
      expect.objectContaining({ error: 'signal-boom' })
    );

    obs.exporter.recordSignal.mockImplementationOnce(() => { throw 'signal-string'; });
    recordToolFailureSignal({
      observability: obs,
      logger,
      generationId: undefined,
      timestampMs: Date.now(),
      level: 'warning',
      code: 'tool_call_budget_exhausted',
      message: 'warn',
      toolCallId: 'call-1',
      toolName: 'tool',
      provider: 'provider',
      model: 'model'
    });

    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to record observability signal event',
      expect.objectContaining({ error: 'signal-string' })
    );
  });
});
