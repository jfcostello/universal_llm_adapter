import { jest } from '@jest/globals';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { ToolCoordinator } from '@/modules/tools/index.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const rawModulePath = path.join(ROOT_DIR, 'tests/fixtures/modules/raw-return.mjs');

describe('ToolCoordinator timeout cleanup', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('clears timeout timer when invocation finishes before timeout', async () => {
    jest.useFakeTimers();

    const coordinator = new ToolCoordinator([
      {
        id: 'raw-module',
        match: { type: 'exact', pattern: 'raw.tool' },
        invoke: { kind: 'module', module: rawModulePath },
        timeoutMs: 1000
      } as any
    ]);

    const result = await coordinator.routeAndInvoke('raw.tool', 'call-raw', {}, { provider: 'p', model: 'm' });
    expect(result).toEqual({ result: 'raw-value' });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('kills spawned command process when timeout fires', async () => {
    jest.useFakeTimers();

    const fakeStdout = new EventEmitter() as any;
    const fakeStderr = new EventEmitter() as any;
    const fakeProc = new EventEmitter() as any;
    fakeProc.stdout = fakeStdout;
    fakeProc.stderr = fakeStderr;
    fakeProc.stdin = { write: jest.fn(), end: jest.fn() };
    fakeProc.kill = jest.fn(() => {
      fakeProc.emit('close', 137);
      return true;
    });

    const coordinator = new ToolCoordinator([
      {
        id: 'cmd-hang',
        match: { type: 'exact', pattern: 'cmd.hang' },
        invoke: { kind: 'command', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'] },
        timeoutMs: 5
      } as any
    ]);

    jest.spyOn(coordinator as any, 'spawnProcess').mockReturnValue(fakeProc);

    const promise = coordinator.routeAndInvoke('cmd.hang', 'call-hang', {}, { provider: 'p', model: 'm' });
    const assertion = expect(promise).rejects.toThrow(
      "Process route 'cmd-hang' failed: Tool execution timeout after 0.005s"
    );
    await jest.advanceTimersByTimeAsync(10);

    await assertion;
    expect(fakeProc.kill).toHaveBeenCalled();
  });

  test('invokeCommand handles already-aborted signals and falls back when kill(SIGKILL) throws', async () => {
    const fakeStdout = new EventEmitter() as any;
    const fakeStderr = new EventEmitter() as any;
    const fakeProc = new EventEmitter() as any;
    fakeProc.stdout = fakeStdout;
    fakeProc.stderr = fakeStderr;
    fakeProc.stdin = { write: jest.fn(), end: jest.fn() };
    const killCalls: any[] = [];
    fakeProc.kill = (arg?: any) => {
      killCalls.push(arg);
      if (arg === 'SIGKILL') {
        throw new Error('kill boom');
      }
      return true;
    };

    const coordinator = new ToolCoordinator([] as any);
    jest.spyOn(coordinator as any, 'spawnProcess').mockReturnValue(fakeProc);

    const abortController = new AbortController();
    abortController.abort();

    const route = {
      id: 'cmd',
      invoke: { kind: 'command', command: 'node', args: [] }
    } as any;
    const ctx = { toolName: 'cmd', callId: 'call', args: {}, provider: 'p', model: 'm', metadata: {} };

    const promise = (coordinator as any).invokeCommand(route, ctx, { signal: abortController.signal });

    // Ensure the promise settles (kill() happens before listeners are attached).
    fakeProc.emit('close', 0);
    await expect(promise).resolves.toEqual({ result: null });

    expect(killCalls).toEqual(['SIGKILL', undefined]);
  });

  test('invokeCommand ignores stdin write errors and still parses stdout', async () => {
    const { invokeCommand } = await import(
      '@/modules/tools/internal/tool-coordinator/internal/invoke-command.ts'
    );

    const proc = new EventEmitter() as any;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();

    const stdin = new EventEmitter() as any;
    stdin.write = () => {
      const error: any = new Error('write EPIPE');
      error.code = 'EPIPE';
      throw error;
    };
    stdin.end = () => {
      const error: any = new Error('end EPIPE');
      error.code = 'EPIPE';
      throw error;
    };
    proc.stdin = stdin;

    const promise = invokeCommand({
      route: { id: 'cmd', invoke: { kind: 'command', command: 'node', args: [] } } as any,
      ctx: { toolName: 'cmd', callId: 'call', args: {}, provider: 'p', model: 'm', metadata: {} },
      spawnProcess: () => proc
    });

    proc.stdout.write('not-json');
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow('Invalid JSON output: not-json');
  });

  test('createTimeout does not schedule a timer when signal already aborted', () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      const coordinator = new ToolCoordinator([] as any);
      const abortController = new AbortController();
      abortController.abort();

      void (coordinator as any).createTimeout(0.001, { signal: abortController.signal });

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test('invoke supports being called without options (no signal)', async () => {
    const coordinator = new ToolCoordinator([] as any);

    const route = {
      id: 'raw-module',
      invoke: { kind: 'module', module: rawModulePath }
    } as any;
    const ctx = { toolName: 'raw.tool', callId: 'call', args: {}, provider: 'p', model: 'm', metadata: {} };

    const result = await (coordinator as any).invoke(route, ctx);
    expect(result).toEqual({ result: 'raw-value' });
  });

  test('createTimeout schedules and rejects when called without options', async () => {
    jest.useFakeTimers();

    const coordinator = new ToolCoordinator([] as any);
    const promise = (coordinator as any).createTimeout(0.001);
    const assertion = expect(promise).rejects.toThrow('Tool execution timeout after 0.001s');

    await jest.advanceTimersByTimeAsync(2);
    await assertion;
  });
});
