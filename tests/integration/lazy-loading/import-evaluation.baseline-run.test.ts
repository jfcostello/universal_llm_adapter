import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (baseline run)', () => {
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

  test('does not evaluate optional tools/MCP/vector/embeddings/logging modules (including toolChoice=null)', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../modules/tools/index.js', () => {
        throw new Error('tools module should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported in baseline');
      });

      const { LLMCoordinator, LLMManager } = await import('@/modules/llm/index.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse() as any);

      const coordinatorA = new LLMCoordinator(createRegistry() as any);
      await coordinatorA.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        settings: {}
      } as any);
      await coordinatorA.close();

      const coordinatorB = new LLMCoordinator(createRegistry() as any);
      await coordinatorB.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        toolChoice: null,
        settings: {}
      } as any);
      await coordinatorB.close();

      const coordinatorC = new LLMCoordinator(createRegistry() as any);
      await coordinatorC.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        toolChoice: 'auto',
        settings: {}
      } as any);
      await coordinatorC.close();
    });
  });
});
