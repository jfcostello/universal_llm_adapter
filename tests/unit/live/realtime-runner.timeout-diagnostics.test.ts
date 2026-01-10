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
});
