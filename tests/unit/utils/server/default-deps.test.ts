import { jest } from '@jest/globals';
import { Readable } from 'stream';

async function importServerModule() {
  return import('@/utils/server/index.ts');
}

describe('utils/server default dependency wiring', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('createServer and /run use default createRegistry and createCoordinator', async () => {
    jest.resetModules();

    const registryInstance = { loadAll: jest.fn().mockResolvedValue(undefined) };
    const runMock = jest.fn().mockResolvedValue({ ok: true });
    const closeMock = jest.fn().mockResolvedValue(undefined);

    const PluginRegistryMock = jest.fn().mockImplementation(() => registryInstance);
    const LLMCoordinatorMock = jest.fn().mockImplementation(() => ({
      run: runMock,
      runStream: jest.fn(),
      close: closeMock
    }));

    const createServerMock = jest.fn();
    let capturedHandler: any;
    const fakeServer: any = {
      listen: jest.fn((_port: any, _host: any, cb: any) => cb()),
      once: jest.fn((_event: any, _cb: any) => fakeServer),
      address: jest.fn(() => ({ port: 1234 })),
      close: jest.fn((cb: any) => cb())
    };
    createServerMock.mockImplementation((handler: any) => {
      capturedHandler = handler;
      return fakeServer;
    });

    (jest as any).unstable_mockModule('@/core/registry.ts', () => ({
      PluginRegistry: PluginRegistryMock
    }));
    (jest as any).unstable_mockModule('@/coordinator/coordinator.ts', () => ({
      LLMCoordinator: LLMCoordinatorMock
    }));
    (jest as any).unstable_mockModule('@/core/logging.ts', () => ({
      closeLogger: jest.fn().mockResolvedValue(undefined),
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn()
      })
    }));
    (jest as any).unstable_mockModule('http', () => ({
      __esModule: true,
      default: { createServer: createServerMock }
    }));

    const { createServer } = await importServerModule();
    const running = await createServer();

    expect(PluginRegistryMock).toHaveBeenCalledWith('./plugins');
    expect(running.url).toBe('http://127.0.0.1:1234');

    const req = new Readable({
      read() {
        this.push(JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} }));
        this.push(null);
      }
    }) as any;
    req.method = 'POST';
    req.url = '/run';
    req.headers = { 'content-type': 'application/json' };

    let body = '';
    const res: any = {
      headersSent: false,
      writeHead: jest.fn(() => {
        res.headersSent = true;
      }),
      end: jest.fn((chunk?: any) => {
        if (chunk) body += chunk.toString();
        res.headersSent = true;
      })
    };

    await capturedHandler(req, res);

    expect(LLMCoordinatorMock).toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(JSON.parse(body).type).toBe('response');
  });

  test('close rejects when underlying server close errors', async () => {
    jest.resetModules();

    const registryInstance = { loadAll: jest.fn().mockResolvedValue(undefined) };
    const PluginRegistryMock = jest.fn().mockImplementation(() => registryInstance);

    const fakeServer: any = {
      listen: jest.fn((_port: any, _host: any, cb: any) => cb()),
      once: jest.fn((_event: any, _cb: any) => fakeServer),
      address: jest.fn(() => ({ port: 1234 })),
      close: jest.fn((cb: any) => cb(new Error('close failed')))
    };

    (jest as any).unstable_mockModule('@/core/registry.ts', () => ({
      PluginRegistry: PluginRegistryMock
    }));
    (jest as any).unstable_mockModule('@/coordinator/coordinator.ts', () => ({
      LLMCoordinator: jest.fn().mockImplementation(() => ({
        run: jest.fn(),
        runStream: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined)
      }))
    }));
    (jest as any).unstable_mockModule('@/core/logging.ts', () => ({
      closeLogger: jest.fn().mockResolvedValue(undefined),
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn()
      })
    }));
    (jest as any).unstable_mockModule('http', () => ({
      __esModule: true,
      default: {
        createServer: jest.fn().mockReturnValue(fakeServer)
      }
    }));

    const { createServer } = await importServerModule();
    const running = await createServer();

    await expect(running.close()).rejects.toThrow('close failed');
  });
});
