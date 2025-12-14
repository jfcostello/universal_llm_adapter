import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (server /run)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not evaluate tools/MCP/vector/embeddings modules when calling /run', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/tools/index.js', () => {
        throw new Error('tools module should not be imported by /run');
      });
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported by /run');
      });
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported by /run');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported by /run');
      });

      const { createServer } = await import('@/modules/server/index.ts');

      const running = await createServer({
        host: '127.0.0.1',
        port: 0,
        registry: { loadAll: jest.fn().mockResolvedValue(undefined) } as any,
        deps: {
          createCoordinator: async () => ({
            run: async () => ({ ok: true }),
            runStream: async function* () {},
            close: async () => {}
          }),
          closeLogger: async () => {}
        }
      });

      const res = await fetch(new URL('/run', running.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [],
          llmPriority: [{ provider: 'p', model: 'm' }],
          settings: {}
        })
      });

      expect(res.status).toBe(200);

      await running.close();
    });
  });
});

