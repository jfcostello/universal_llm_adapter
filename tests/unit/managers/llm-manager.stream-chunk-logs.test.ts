import { jest } from '@jest/globals';

function createAsyncChunkStream(chunks: string[]): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield Buffer.from(chunk);
      }
    }
  };
}

describe('unit/managers/llm-manager stream chunk info logs', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('disabling chunk logs suppresses per-chunk info logs', async () => {
    process.env.LLM_ADAPTER_LLM_STREAM_CHUNK_LOGS_ENABLED = '0';

    const compat = {
      buildPayload: () => ({}),
      getStreamingFlags: () => ({ stream: true })
    };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;

    const { LLMManager } = await import('@/modules/llm/index.ts');
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: createAsyncChunkStream(['data: {"x":1}\n\n'])
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = { info: jest.fn(), error: jest.fn() } as any;

    const manifest: any = {
      id: 'p',
      compat: 'x',
      endpoint: {
        urlTemplate: 'http://service/{model}',
        streamingUrlTemplate: 'http://service/{model}',
        method: 'POST',
        headers: {}
      }
    };

    const itr = manager.streamProvider(manifest, 'm', {}, [], [], undefined, {}, logger);
    for await (const _chunk of itr) {
      // consume
    }

    const hasChunkInfoLog = logger.info.mock.calls.some((call: any[]) => call?.[0] === 'Received chunk from response.data');
    expect(hasChunkInfoLog).toBe(false);
  });

  test('enabling chunk logs emits per-chunk info logs', async () => {
    process.env.LLM_ADAPTER_LLM_STREAM_CHUNK_LOGS_ENABLED = '1';

    const compat = {
      buildPayload: () => ({}),
      getStreamingFlags: () => ({ stream: true })
    };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;

    const { LLMManager } = await import('@/modules/llm/index.ts');
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: createAsyncChunkStream(['data: {"x":1}\n\n'])
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = { info: jest.fn(), error: jest.fn() } as any;

    const manifest: any = {
      id: 'p',
      compat: 'x',
      endpoint: {
        urlTemplate: 'http://service/{model}',
        streamingUrlTemplate: 'http://service/{model}',
        method: 'POST',
        headers: {}
      }
    };

    const itr = manager.streamProvider(manifest, 'm', {}, [], [], undefined, {}, logger);
    for await (const _chunk of itr) {
      // consume
    }

    const hasChunkInfoLog = logger.info.mock.calls.some((call: any[]) => call?.[0] === 'Received chunk from response.data');
    expect(hasChunkInfoLog).toBe(true);
  });

  test('default behavior has chunk logs disabled when env override is absent', async () => {
    delete process.env.LLM_ADAPTER_LLM_STREAM_CHUNK_LOGS_ENABLED;

    const compat = {
      buildPayload: () => ({}),
      getStreamingFlags: () => ({ stream: true })
    };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;

    const { LLMManager } = await import('@/modules/llm/index.ts');
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: createAsyncChunkStream(['data: {"x":1}\n\n'])
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = { info: jest.fn(), error: jest.fn() } as any;

    const manifest: any = {
      id: 'p',
      compat: 'x',
      endpoint: {
        urlTemplate: 'http://service/{model}',
        streamingUrlTemplate: 'http://service/{model}',
        method: 'POST',
        headers: {}
      }
    };

    const itr = manager.streamProvider(manifest, 'm', {}, [], [], undefined, {}, logger);
    for await (const _chunk of itr) {
      // consume
    }

    const hasChunkInfoLog = logger.info.mock.calls.some((call: any[]) => call?.[0] === 'Received chunk from response.data');
    expect(hasChunkInfoLog).toBe(false);
  });
});
