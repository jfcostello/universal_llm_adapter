import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (MCP-only)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createRegistry() {
    return {
      getProvider: async (id: string) => ({ id, compat: 'stub-compat' }),
      getProcessRoutes: async () => [],
      getMCPServers: async (ids: string[]) =>
        ids.map(id => ({ id, command: 'node' }))
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

  test('does not evaluate vector/embeddings/logging modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module should not be imported for MCP-only');
      });

      // Allow tools module, but keep it inert.
      jest.unstable_mockModule('../../../modules/tools/index.js', () => ({
        ToolCoordinator: class ToolCoordinator {
          constructor(..._args: any[]) {}
          setVectorContexts() {}
          async routeAndInvoke() {
            throw new Error('ToolCoordinator not used in MCP-only import test');
          }
          async close() {}
        },
        sanitizeToolChoice: (choice: any) => choice,
        collectTools: async () => ({
          tools: [],
          mcpServers: [],
          toolNameMap: {},
          vectorSearchAliasMaps: undefined
        }),
        runToolLoop: async () => {
          throw new Error('runToolLoop not used in MCP-only import test');
        }
      }));

      // Explicitly allow MCP module, but prevent any network/process work.
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => ({
        MCPManager: class MCPManager {
          constructor(private servers: any[]) {}
          getPool() {
            return undefined;
          }
          async gatherTools() {
            return [[], this.servers.map((s: any) => s.id)];
          }
          async close() {}
        }
      }));

      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported for MCP-only');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported for MCP-only');
      });

      const { LLMCoordinator, LLMManager } = await import('@/modules/llm/index.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse() as any);

      const coordinator = new LLMCoordinator(createRegistry() as any);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        mcpServers: ['local'],
        settings: {}
      } as any);

      await coordinator.close();
    });
  });
});
