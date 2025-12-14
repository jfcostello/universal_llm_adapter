import { jest } from '@jest/globals';

describe('utils/server default dependency wiring', () => {
  const runMock = jest.fn().mockResolvedValue({ ok: true });
  const closeMock = jest.fn().mockResolvedValue(undefined);

  const executeMock = jest.fn().mockResolvedValue({ ok: true });
  const vectorCloseMock = jest.fn().mockResolvedValue(undefined);

  const embedExecuteMock = jest.fn().mockResolvedValue({ ok: true });
  const embedCloseMock = jest.fn().mockResolvedValue(undefined);

  const LLMCoordinatorMock = jest.fn().mockImplementation(() => ({
    run: runMock,
    runStream: jest.fn(),
    close: closeMock
  }));

  const VectorStoreCoordinatorMock = jest.fn().mockImplementation(() => ({
    execute: executeMock,
    executeStream: jest.fn(),
    close: vectorCloseMock
  }));

  const EmbeddingCoordinatorMock = jest.fn().mockImplementation(() => ({
    execute: embedExecuteMock,
    close: embedCloseMock
  }));

  let createServer!: typeof import('@/modules/server/index.ts').createServer;
  let running!: Awaited<ReturnType<typeof import('@/modules/server/index.ts').createServer>>;

  beforeAll(async () => {
    jest.unstable_mockModule('../../../../modules/llm/index.js', () => ({
      LLMCoordinator: LLMCoordinatorMock
    }));
    jest.unstable_mockModule('../../../../modules/vector/index.js', () => ({
      VectorStoreCoordinator: VectorStoreCoordinatorMock
    }));
    jest.unstable_mockModule('../../../../modules/embeddings/index.js', () => ({
      EmbeddingCoordinator: EmbeddingCoordinatorMock
    }));
    jest.unstable_mockModule('../../../../modules/logging/index.js', () => {
      const closeLogger = jest.fn().mockResolvedValue(undefined);
      const getLogger = jest.fn().mockReturnValue({
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn()
      });
      const getVectorLogger = jest.fn().mockReturnValue({
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn()
      });
      const getEmbeddingLogger = jest.fn().mockReturnValue({
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn()
      });

      return {
        closeLogger,
        getLogger,
        getVectorLogger,
        getEmbeddingLogger,
        createLoggingDeps: () => ({
          getLogger,
          getVectorLogger,
          getEmbeddingLogger,
          closeLogger
        })
      };
    });

    ({ createServer } = await import('@/modules/server/index.ts'));

    running = await createServer({
      registry: { loadAll: jest.fn().mockResolvedValue(undefined) } as any,
      host: '127.0.0.1',
      port: 0
    });
  });

  afterAll(async () => {
    if (running) {
      await running.close();
    }
  });

  beforeEach(() => {
    runMock.mockClear();
    closeMock.mockClear();
    executeMock.mockClear();
    vectorCloseMock.mockClear();
    embedExecuteMock.mockClear();
    embedCloseMock.mockClear();
    LLMCoordinatorMock.mockClear();
    VectorStoreCoordinatorMock.mockClear();
    EmbeddingCoordinatorMock.mockClear();
  });

  test('POST /run uses default createCoordinator', async () => {
    const res = await fetch(new URL('/run', running.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [],
        llmPriority: [{ provider: 'p', model: 'm' }],
        metadata: { correlationId: 'server-default-deps' },
        settings: {}
      })
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.type).toBe('response');

    expect(LLMCoordinatorMock).toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  test('POST /vector/run uses default createVectorCoordinator', async () => {
    const res = await fetch(new URL('/vector/run', running.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'query',
        store: 's',
        input: { vector: [0.1], topK: 1 }
      })
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.type).toBe('response');

    expect(VectorStoreCoordinatorMock).toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalled();
    expect(vectorCloseMock).toHaveBeenCalled();
  });

  test('POST /vector/embeddings/run uses default createEmbeddingCoordinator', async () => {
    const res = await fetch(new URL('/vector/embeddings/run', running.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'embed',
        embeddingPriority: [{ provider: 'p' }],
        input: { texts: ['hello'] }
      })
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.type).toBe('response');

    expect(EmbeddingCoordinatorMock).toHaveBeenCalled();
    expect(embedExecuteMock).toHaveBeenCalled();
    expect(embedCloseMock).toHaveBeenCalled();
  });

  test('close rejects when underlying server close errors', async () => {
    const local = await createServer({
      registry: { loadAll: jest.fn().mockResolvedValue(undefined) } as any,
      host: '127.0.0.1',
      port: 0
    });

    const originalClose = local.server.close.bind(local.server);
    local.server.close = ((cb: any) => cb(new Error('close failed'))) as any;

    await expect(local.close()).rejects.toThrow('close failed');

    local.server.close = originalClose as any;
    await new Promise<void>((resolve, reject) => {
      originalClose((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
});
