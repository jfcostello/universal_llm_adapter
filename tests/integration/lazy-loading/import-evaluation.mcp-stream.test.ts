import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (MCP-only stream)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createRegistry() {
    return {
      getProvider: async (id: string) => ({ id, compat: 'stub-compat' }),
      getCompatModule: async () => ({ parseStreamChunk: () => ({ text: 'ok' }) }),
      getProcessRoutes: async () => [],
      getMCPServers: async (ids: string[]) => ids.map(id => ({ id, command: 'node' }))
    };
  }

  test('does not evaluate vector/embeddings/logging modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module should not be imported for MCP-only stream');
      });

      // Explicitly allow MCP module, but prevent any process work.
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => ({
        MCPManager: class MCPManager {
          constructor(private servers: any[]) {}
          getPool() {
            return undefined;
          }
          async gatherTools(_ids: string[]) {
            return [[], this.servers.map((s: any) => s.id)];
          }
          async close() {}
        }
      }));

      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported for MCP-only stream');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported for MCP-only stream');
      });

      const { LLMCoordinator, LLMManager } = await import('@/modules/llm/index.ts');

      jest
        .spyOn(LLMManager.prototype as any, 'streamProvider')
        .mockImplementation(async function* () {
          yield { chunk: 1 };
        });

      const coordinator = new LLMCoordinator(createRegistry() as any);

      for await (const _event of coordinator.runStream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        mcpServers: ['local'],
        settings: {}
      } as any)) {
        // exhaust stream
      }

      await coordinator.close();
    });
  });
});

