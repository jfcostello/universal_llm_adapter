import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (vector context)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createRegistry() {
    return {
      getProvider: async (id: string) => ({ id, compat: 'stub-compat' })
    };
  }

  function mockResponse() {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      provider: 'stub-provider',
      model: 'stub-model',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
    };
  }

  test('does not evaluate tools/MCP/logging modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module should not be imported for vector-context-only');
      });
      jest.unstable_mockModule('../../../modules/tools/index.js', () => {
        throw new Error('tools module should not be imported for vector-context-only');
      });
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported for vector-context-only');
      });

      let vectorModuleImported = false;
      let embeddingsModuleImported = false;

      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        embeddingsModuleImported = true;
        return {
          EmbeddingManager: class EmbeddingManager {
            constructor(..._args: any[]) {}
          }
        };
      });

      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        vectorModuleImported = true;
        return {
          VectorStoreManager: class VectorStoreManager {
            constructor(..._args: any[]) {}
          },
          VectorContextInjector: class VectorContextInjector {
            constructor(..._args: any[]) {}
            async injectContext(messages: any[]) {
              return { messages };
            }
          }
        };
      });

      const { LLMCoordinator, LLMManager } = await import('@/modules/llm/index.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse() as any);

      const coordinator = new LLMCoordinator(createRegistry() as any);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        vectorContexts: [{
          mode: 'auto',
          stores: ['memory'],
          topK: 1
        }],
        settings: {}
      } as any);

      expect(vectorModuleImported).toBe(true);
      expect(embeddingsModuleImported).toBe(true);

      await coordinator.close();
    });
  });
});
