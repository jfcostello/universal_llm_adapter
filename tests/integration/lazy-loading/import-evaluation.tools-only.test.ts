import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (tools-only)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createRegistry() {
    return {
      getProvider: async (id: string) => ({ id, compat: 'stub-compat' }),
      getProcessRoutes: async () => []
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

  test('does not evaluate MCP/vector/embeddings/logging modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module should not be imported for tools-only');
      });

      // Allow tools module, but stub it to avoid doing any process work.
      jest.unstable_mockModule('../../../modules/tools/index.js', () => ({
        ToolCoordinator: class ToolCoordinator {
          constructor(..._args: any[]) {}
          setVectorContexts() {}
          async routeAndInvoke() {
            throw new Error('ToolCoordinator not used in tools-only import test');
          }
          async close() {}
        },
        sanitizeToolChoice: (choice: any) => choice,
        collectTools: async ({ spec }: any) => ({
          tools: spec.tools ?? [],
          mcpServers: [],
          toolNameMap: {},
          vectorSearchAliasMaps: undefined
        }),
        runToolLoop: async () => {
          throw new Error('runToolLoop not used in tools-only import test');
        }
      }));

      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported for tools-only');
      });

      const { LLMCoordinator, LLMManager } = await import('@/modules/llm/index.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse() as any);

      const coordinator = new LLMCoordinator(createRegistry() as any);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        tools: [
          {
            name: 'inline_tool',
            description: 'Inline tool',
            parametersJsonSchema: { type: 'object', properties: {} }
          }
        ],
        settings: {}
      } as any);

      await coordinator.close();
    });
  });
});
