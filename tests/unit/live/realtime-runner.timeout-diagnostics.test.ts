import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

describe('tests/helpers/realtime-runner: timeout diagnostics', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('includes recent envelope context when wait_for_event times out', async () => {
    jest.useFakeTimers();

    const { PassThrough } = await import('stream');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const child: any = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = jest.fn();
    child.once = child.once.bind(child);

    const spawn = jest.fn().mockReturnValue(child);

    (jest as any).unstable_mockModule('child_process', () => ({
      __esModule: true,
      default: { spawn },
      spawn
    }));
    (jest as any).unstable_mockModule('node:child_process', () => ({
      __esModule: true,
      default: { spawn },
      spawn
    }));

    const { runRealtimeScenario } = await import('@tests/helpers/realtime-runner.ts');

    const promise = runRealtimeScenario({
      env: { ...process.env, LLM_LIVE_TRANSPORT: 'cli' },
      pluginsPath: './plugins',
      cwd: process.cwd(),
      spec: { provider: 'p', model: 'm', history: [], timeout: { idleTimeoutMs: 0, maxDurationMs: 0 } },
      steps: [{ type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 25 }]
    });

    // Emit a ready envelope and an unrelated event, then stall so wait_for_event times out.
    expect(spawn).toHaveBeenCalledTimes(1);

    stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'ready' } })}\n`);
    stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'tool_call.start' } })}\n`);

    const assertion = expect(promise).rejects.toThrow(/tool_call\.start/);

    await jest.advanceTimersByTimeAsync(30);
    await assertion;
  });

  test('retries when the session closes before the expected event', async () => {
    const { PassThrough } = await import('stream');

    const makeChild = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      const child: any = new EventEmitter();
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = jest.fn();
      child.once = child.once.bind(child);

      stdin.on('finish', () => {
        child.emit('close', 0);
      });

      return { child, stdout };
    };

    const first = makeChild();
    const second = makeChild();

    const spawn = jest.fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);

    (jest as any).unstable_mockModule('child_process', () => ({
      __esModule: true,
      default: { spawn },
      spawn
    }));
    (jest as any).unstable_mockModule('node:child_process', () => ({
      __esModule: true,
      default: { spawn },
      spawn
    }));

    const { runRealtimeScenario } = await import('@tests/helpers/realtime-runner.ts');

    const promise = runRealtimeScenario({
      env: { ...process.env, LLM_LIVE_TRANSPORT: 'cli' },
      pluginsPath: './plugins',
      cwd: process.cwd(),
      spec: { provider: 'p', model: 'm', history: [], timeout: { idleTimeoutMs: 0, maxDurationMs: 0 } },
      steps: [{ type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 1000 }],
      timeoutMs: 1000
    });

    expect(spawn).toHaveBeenCalledTimes(1);

    first.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'ready' } })}\n`);
    first.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'closed', reason: 'provider_close' } })}\n`);

    const retryStart = Date.now();
    while (spawn.mock.calls.length < 2) {
      if (Date.now() - retryStart > 2000) throw new Error('Timed out waiting for retry attempt');
      await new Promise(res => setTimeout(res, 10));
    }

    second.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'ready' } })}\n`);
    await new Promise(res => setTimeout(res, 0));
    second.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'tool_call.end', name: 'test.echo' } })}\n`);

    const result = await promise;
    expect(result.code).toBe(0);
  });

  test('retries when the session closes early with ws_close error noise', async () => {
    const { PassThrough } = await import('stream');

    const makeChild = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      const child: any = new EventEmitter();
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = jest.fn();
      child.once = child.once.bind(child);

      stdin.on('finish', () => {
        child.emit('close', 0);
      });

      return { child, stdout };
    };

    const first = makeChild();
    const second = makeChild();

    const spawn = jest.fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);

    (jest as any).unstable_mockModule('child_process', () => ({
      __esModule: true,
      default: { spawn },
      spawn
    }));
    (jest as any).unstable_mockModule('node:child_process', () => ({
      __esModule: true,
      default: { spawn },
      spawn
    }));

    const { runRealtimeScenario } = await import('@tests/helpers/realtime-runner.ts');

    const promise = runRealtimeScenario({
      env: { ...process.env, LLM_LIVE_TRANSPORT: 'cli' },
      pluginsPath: './plugins',
      cwd: process.cwd(),
      spec: { provider: 'p', model: 'm', history: [], timeout: { idleTimeoutMs: 0, maxDurationMs: 0 } },
      steps: [{ type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 1000 }],
      timeoutMs: 1000
    });

    expect(spawn).toHaveBeenCalledTimes(1);

    first.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'ready' } })}\n`);
    first.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'error', code: 'ws_close', message: 'Realtime websocket closed unexpectedly' } })}\n`);
    first.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'closed', reason: 'provider_close' } })}\n`);

    const retryStart = Date.now();
    while (spawn.mock.calls.length < 2) {
      if (Date.now() - retryStart > 2000) throw new Error('Timed out waiting for retry attempt');
      await new Promise(res => setTimeout(res, 10));
    }

    second.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'ready' } })}\n`);
    await new Promise(res => setTimeout(res, 0));
    second.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'tool_call.end', name: 'test.echo' } })}\n`);

    const result = await promise;
    expect(result.code).toBe(0);
  });
});
