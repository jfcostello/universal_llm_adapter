import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (baseline stream)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createRegistry() {
    return {
      getProvider: async (id: string) => ({ id, compat: 'stub-compat' }),
      getCompatModule: async () => ({ parseStreamChunk: () => ({ text: 'ok' }) })
    };
  }

  test('does not evaluate optional tools/MCP/vector/embeddings/logging modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module should not be imported in baseline stream');
      });
      jest.unstable_mockModule('../../../modules/tools/index.js', () => {
        throw new Error('tools module should not be imported in baseline stream');
      });
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported in baseline stream');
      });
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported in baseline stream');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported in baseline stream');
      });

      const { LLMCoordinator, LLMManager } = await import('@/modules/llm/index.ts');

      // Avoid any HTTP/SDK streaming work; only the lazy-loading boundary matters here.
      jest
        .spyOn(LLMManager.prototype as any, 'streamProvider')
        .mockImplementation(async function* () {
          yield { chunk: 1 };
        });

      const coordinator = new LLMCoordinator(createRegistry() as any);

      for await (const _event of coordinator.runStream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        settings: {}
      } as any)) {
        // exhaust stream
      }

      await coordinator.close();
    });
  });
});

