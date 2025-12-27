import { jest } from '@jest/globals';

import { handle } from '@/plugins/modules/test-control/index.ts';

describe('plugins/modules/test-control', () => {
  test('returns override and coerces invalid sleepMs to 0', async () => {
    await expect(
      handle({
        toolName: 'test.control',
        args: { override: 'x', sleepMs: 'nope' as any }
      })
    ).resolves.toEqual({
      result: {
        tool: 'test.control',
        tool_type_response_override_terminal: 'x',
        sleptMs: 0
      }
    });

    const res = await handle({
      toolName: 'test.control',
      args: { override: false, sleepMs: Number.POSITIVE_INFINITY }
    });

    expect(res.result.sleptMs).toBe(0);
  });

  test('calls sleep and resolves immediately when sleepMs floors to 0', async () => {
    const res = await handle({
      toolName: 'test.control',
      args: { override: true, sleepMs: 0.5 }
    });

    expect(res.result).toEqual({
      tool: 'test.control',
      tool_type_response_override_terminal: true,
      sleptMs: 0.5
    });
  });

  test('sleeps and resolves (with and without abortSignal)', async () => {
    jest.useFakeTimers();

    const withoutSignal = handle({
      toolName: 'test.control',
      args: { sleepMs: 5 }
    });

    jest.advanceTimersByTime(5);

    await expect(withoutSignal).resolves.toEqual({
      result: {
        tool: 'test.control',
        tool_type_response_override_terminal: undefined,
        sleptMs: 5
      }
    });

    const controller = new AbortController();
    const withSignal = handle({
      toolName: 'test.control',
      args: { override: null, sleepMs: 7 },
      abortSignal: controller.signal
    });

    jest.advanceTimersByTime(7);

    await expect(withSignal).resolves.toEqual({
      result: {
        tool: 'test.control',
        tool_type_response_override_terminal: null,
        sleptMs: 7
      }
    });

    jest.useRealTimers();
  });

  test('rejects when abortSignal is aborted (before and during sleep)', async () => {
    const preAborted = new AbortController();
    preAborted.abort();

    await expect(
      handle({
        toolName: 'test.control',
        args: { sleepMs: 5 },
        abortSignal: preAborted.signal
      })
    ).rejects.toThrow('aborted');

    jest.useFakeTimers();

    const midAbort = new AbortController();
    const pending = handle({
      toolName: 'test.control',
      args: { sleepMs: 50 },
      abortSignal: midAbort.signal
    });

    midAbort.abort();

    await expect(pending).rejects.toThrow('aborted');

    jest.useRealTimers();
  });
});

