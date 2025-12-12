import { jest } from '@jest/globals';
import * as CliModule from '@/llm_coordinator.ts';

const { createProgram } = CliModule;

function createServeDeps(overrides: Partial<CliModule.CliDependencies> = {}) {
  const runningServer = {
    url: 'http://127.0.0.1:4000',
    server: {} as any,
    close: jest.fn().mockResolvedValue(undefined)
  };

  const baseDeps: CliModule.CliDependencies = {
    createRegistry: jest.fn(),
    createCoordinator: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    exit: jest.fn(),
    createServer: jest.fn().mockResolvedValue(runningServer)
  } as any;

  return {
    deps: { ...baseDeps, ...overrides },
    runningServer
  };
}

describe('llm_coordinator serve command', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('maps flags to createServer options and logs url', async () => {
    const { deps } = createServeDeps();
    const program = createProgram(deps);

    await program.parseAsync([
      'node',
      'llm-coordinator',
      'serve',
      '--host',
      '0.0.0.0',
      '--port',
      '3333',
      '--plugins',
      './plugins',
      '--batch-id',
      'batchX',
      '--max-request-bytes',
      '123',
      '--body-read-timeout-ms',
      '456',
      '--stream-idle-timeout-ms',
      '789',
      '--max-concurrent-requests',
      '10',
      '--max-concurrent-streams',
      '11',
      '--max-queue-size',
      '12',
      '--queue-timeout-ms',
      '13',
      '--auth-enabled',
      '--auth-header-name',
      'x-my-key',
      '--no-auth-allow-bearer',
      '--rate-limit-enabled',
      '--rate-limit-requests-per-minute',
      '99',
      '--rate-limit-burst',
      '7',
      '--cors-enabled',
      '--no-security-headers-enabled'
    ]);

    expect(deps.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '0.0.0.0',
        port: 3333,
        pluginsPath: './plugins',
        batchId: 'batchX',
        maxRequestBytes: 123,
        bodyReadTimeoutMs: 456,
        streamIdleTimeoutMs: 789,
        maxConcurrentRequests: 10,
        maxConcurrentStreams: 11,
        maxQueueSize: 12,
        queueTimeoutMs: 13,
        auth: expect.objectContaining({
          enabled: true,
          headerName: 'x-my-key',
          allowBearer: false
        }),
        rateLimit: expect.objectContaining({
          enabled: true,
          requestsPerMinute: 99,
          burst: 7
        }),
        cors: expect.objectContaining({
          enabled: true
        }),
        securityHeadersEnabled: false
      })
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('http://'));
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test('supports additional auth and rate-limit flags without overriding defaults unless provided', async () => {
    const { deps } = createServeDeps();
    const program = createProgram(deps);

    await program.parseAsync([
      'node',
      'llm-coordinator',
      'serve',
      '--auth-enabled',
      '--no-auth-allow-api-key-header',
      '--auth-realm',
      'realmY',
      '--rate-limit-enabled',
      '--rate-limit-trust-proxy-headers'
    ]);

    expect(deps.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          enabled: true,
          allowApiKeyHeader: false,
          realm: 'realmY'
        }),
        rateLimit: expect.objectContaining({
          enabled: true,
          trustProxyHeaders: true
        })
      })
    );
  });

  test('uses default plugins path when flag absent', async () => {
    const { deps } = createServeDeps();
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm-coordinator', 'serve']);

    expect(deps.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ pluginsPath: './plugins' })
    );
  });

  test('registers signal handlers that close server then exit', async () => {
    const handlers: Record<string, any> = {};
    jest.spyOn(process, 'on').mockImplementation((event: any, handler: any) => {
      handlers[event] = handler;
      return process;
    });

    const { deps, runningServer } = createServeDeps();
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm-coordinator', 'serve']);

    await handlers.SIGINT();
    await handlers.SIGINT();

    expect(runningServer.close).toHaveBeenCalled();
    expect(runningServer.close).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  test('exits with error when createServer dependency missing', async () => {
    const { deps } = createServeDeps({ createServer: undefined });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm-coordinator', 'serve']);

    expect(deps.error).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  test('string errors fall back to String(error) in output', async () => {
    const { deps } = createServeDeps({
      createServer: jest.fn().mockRejectedValue('boom')
    });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm-coordinator', 'serve']);

    expect(deps.error).toHaveBeenCalledWith(JSON.stringify({ error: 'boom' }));
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  test('invalid numeric flags reject during parsing', async () => {
    const { deps } = createServeDeps();
    const program = createProgram(deps);

    await expect(
      program.parseAsync(['node', 'llm-coordinator', 'serve', '--port', 'not-a-number'])
    ).rejects.toBeDefined();
  });

  test('can start and shutdown using default createServer', async () => {
    const handlers: Record<string, any> = {};
    jest.spyOn(process, 'on').mockImplementation((event: any, handler: any) => {
      handlers[event] = handler;
      return process;
    });

    const log = jest.fn();
    const error = jest.fn();
    const exit = jest.fn();
    const program = createProgram({ log, error, exit });

    await program.parseAsync(['node', 'llm-coordinator', 'serve']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('http://'));

    await handlers.SIGTERM();

    expect(exit).toHaveBeenCalledWith(0);
  });

});
