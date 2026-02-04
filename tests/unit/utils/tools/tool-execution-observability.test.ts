import { describe, expect, test, jest } from '@jest/globals';
import { recordToolExecutionObservability } from '@/modules/tools/internal/tool-loop/internal/observability.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

function createLoggerStub() {
  return {
    warning: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  } as any;
}

function createObservability(options: Partial<Record<string, any>> = {}) {
  const recordToolExecution = jest.fn();
  return {
    recordToolExecution,
    observability: {
      exporter: {
        recordLLMRequest: jest.fn(),
        recordLLMResponse: jest.fn(),
        recordToolExecution,
        flush: jest.fn().mockResolvedValue(undefined)
      },
      traceId: 'trace-123',
      sessionId: 'session-456',
      metadata: { correlationId: 'corr-789' },
      captureMessages: 'full',
      captureToolArgs: true,
      captureRequestPayload: true,
      captureRawResponse: true,
      sampleRate: 1,
      maxInputTextBytes: 4096,
      maxOutputTextBytes: 4096,
      maxJsonBytes: 8192,
      ...options
    } as any
  };
}

describe('recordToolExecutionObservability', () => {
  const originalEnv = process.env;

  test('is a no-op when observability is undefined', () => {
    const logger = createLoggerStub();
    expect(() =>
      recordToolExecutionObservability({
        observability: undefined,
        logger,
        generationId: undefined,
        provider: 'p',
        model: 'm',
        toolCallId: 'call-1',
        toolName: 'tool',
        args: { a: 1 },
        result: { ok: true },
        resultText: 'ok',
        startTimeMs: 1,
        endTimeMs: 2
      })
    ).not.toThrow();
  });

  test('respects captureMessages="none" (no result fields) and captureToolArgs=false', () => {
    const logger = createLoggerStub();
    const { observability, recordToolExecution } = createObservability({ captureMessages: 'none', captureToolArgs: false });

    recordToolExecutionObservability({
      observability,
      logger,
      generationId: 'gen-1',
      provider: 'p',
      model: 'm',
      toolCallId: 'call-1',
      toolName: 'tool',
      args: { secret: 'abcd' },
      result: { ok: true },
      resultText: 'ok',
      startTimeMs: 1,
      endTimeMs: 2
    });

    expect(recordToolExecution).toHaveBeenCalledWith(
      expect.not.objectContaining({ resultText: expect.anything(), result: expect.anything(), args: expect.anything() })
    );
  });

  test('respects captureMessages="text" and captureToolArgs=true (args + resultText only)', () => {
    const logger = createLoggerStub();
    const { observability, recordToolExecution } = createObservability({ captureMessages: 'text', captureToolArgs: true });

    recordToolExecutionObservability({
      observability,
      logger,
      generationId: 'gen-1',
      provider: 'p',
      model: 'm',
      toolCallId: 'call-1',
      toolName: 'tool',
      args: { a: 1 },
      result: { ok: true },
      resultText: 'ok',
      startTimeMs: 1,
      endTimeMs: 2
    });

    expect(recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        generationId: 'gen-1',
        toolCallId: 'call-1',
        toolName: 'tool',
        args: expect.anything(),
        resultText: 'ok'
      })
    );
    expect(recordToolExecution.mock.calls[0][0]).not.toHaveProperty('result');
  });

  test('respects captureMessages="full" and includes error fields', () => {
    const logger = createLoggerStub();
    const { observability, recordToolExecution } = createObservability({ captureMessages: 'full', captureToolArgs: true });

    recordToolExecutionObservability({
      observability,
      logger,
      generationId: 'gen-1',
      provider: 'p',
      model: 'm',
      toolCallId: 'call-1',
      toolName: 'tool',
      args: { a: 1 },
      result: { ok: true },
      resultText: 'ok',
      error: { message: 'boom', code: 'E_TOOL', retryable: true },
      startTimeMs: 1,
      endTimeMs: 2
    });

    expect(recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { message: 'boom', code: 'E_TOOL', retryable: true },
        result: expect.anything(),
        resultText: 'ok'
      })
    );
  });

  test('omits optional error fields when missing (and falls back error message)', () => {
    const logger = createLoggerStub();
    const { observability, recordToolExecution } = createObservability({ captureMessages: 'full', captureToolArgs: true });

    recordToolExecutionObservability({
      observability,
      logger,
      generationId: 'gen-1',
      provider: 'p',
      model: 'm',
      toolCallId: 'call-1',
      toolName: 'tool',
      args: { a: 1 },
      result: { ok: true },
      resultText: 'ok',
      error: { message: '' },
      startTimeMs: 1,
      endTimeMs: 2
    });

    expect(recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { message: 'error' }
      })
    );
  });

  test('logs TOOL_EXECUTION events in live mode and swallows exporter errors', () => {
    process.env = { ...originalEnv, LLM_LIVE: '1' };

    const logger = createLoggerStub();
    const { observability } = createObservability({ captureMessages: 'text', captureToolArgs: true });

    (observability.exporter.recordToolExecution as any).mockImplementation(() => {
      throw new Error('fail');
    });

    expect(() =>
      recordToolExecutionObservability({
        observability,
        logger,
        generationId: 'gen-1',
        provider: 'p',
        model: 'm',
        toolCallId: 'call-1',
        toolName: 'tool',
        args: undefined,
        result: undefined,
        resultText: 'ok',
        startTimeMs: 1,
        endTimeMs: 2
      })
    ).not.toThrow();

    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to record observability tool execution event',
      expect.objectContaining({ error: 'fail' })
    );

    process.env = originalEnv;
  });

  test('writes a TOOL_EXECUTION live log when LLM_LIVE=1', async () => {
    process.env = { ...originalEnv, LLM_LIVE: '1' };

    await withTempCwd('tool-execution-obs-live', async () => {
      const logger = createLoggerStub();
      const { observability } = createObservability({ captureMessages: 'text', captureToolArgs: true });

      recordToolExecutionObservability({
        observability,
        logger,
        generationId: 'gen-1',
        provider: 'p',
        model: 'm',
        toolCallId: 'call-1',
        toolName: 'tool',
        args: { a: 1 },
        result: { ok: true },
        resultText: 'ok',
        startTimeMs: 1,
        endTimeMs: 2
      });
    });

    process.env = originalEnv;
  });

  test('falls back to default capture settings when capture fields are missing', () => {
    const logger = createLoggerStub();
    const { observability, recordToolExecution } = createObservability();
    delete (observability as any).captureMessages;
    delete (observability as any).captureToolArgs;

    recordToolExecutionObservability({
      observability,
      logger,
      generationId: 'gen-1',
      provider: 'p',
      model: 'm',
      toolCallId: 'call-1',
      toolName: 'tool',
      args: { a: 1 },
      result: { ok: true },
      resultText: 'ok',
      startTimeMs: 1,
      endTimeMs: 2
    });

    expect(recordToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.anything(),
        result: expect.anything(),
        resultText: 'ok'
      })
    );
  });
});
