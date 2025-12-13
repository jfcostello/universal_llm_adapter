import { jest } from '@jest/globals';
import path from 'path';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

describe('integration/lazy-loading/import-evaluation', () => {
  const originalCwd = process.cwd();
  const pluginsDir = path.join(ROOT_DIR, 'tests', 'fixtures', 'plugins', 'basic');

  beforeAll(() => {
    process.chdir(ROOT_DIR);
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockResponse() {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      provider: 'test-provider',
      model: 'stub-model',
      finishReason: 'stop',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2
      }
    };
  }

  test('baseline run does not evaluate optional MCP/vector modules', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../mcp/mcp-manifest.js', () => {
        throw new Error('mcp-manifest should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../mcp/mcp-client.js', () => {
        throw new Error('mcp-client should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../managers/mcp-manager.js', () => {
        throw new Error('mcp-manager should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../managers/vector-store-manager.js', () => {
        throw new Error('vector-store-manager should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../managers/embedding-manager.js', () => {
        throw new Error('embedding-manager should not be imported in baseline');
      });
      jest.unstable_mockModule('../../../utils/vector/vector-context-injector.js', () => {
        throw new Error('vector-context-injector should not be imported in baseline');
      });

      const { PluginRegistry } = await import('@/core/registry.ts');
      const { LLMCoordinator } = await import('@/coordinator/coordinator.ts');
      const { LLMManager } = await import('@/managers/llm-manager.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockImplementation(async function(this: any, ...args: any[]) {
          const provider = args[0];
          await this.registry.getCompatModule(provider.compat);
          return mockResponse();
        });

      const registry = new PluginRegistry(pluginsDir);
      const coordinator = new LLMCoordinator(registry);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
        settings: {}
      } as any);

      await coordinator.close();
    });
  });

  test('tools-only run does not evaluate MCP/vector modules', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../mcp/mcp-manifest.js', () => {
        throw new Error('mcp-manifest should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../mcp/mcp-client.js', () => {
        throw new Error('mcp-client should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../managers/mcp-manager.js', () => {
        throw new Error('mcp-manager should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../managers/vector-store-manager.js', () => {
        throw new Error('vector-store-manager should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../managers/embedding-manager.js', () => {
        throw new Error('embedding-manager should not be imported for tools-only');
      });
      jest.unstable_mockModule('../../../utils/vector/vector-context-injector.js', () => {
        throw new Error('vector-context-injector should not be imported for tools-only');
      });

      const { PluginRegistry } = await import('@/core/registry.ts');
      const { LLMCoordinator } = await import('@/coordinator/coordinator.ts');
      const { LLMManager } = await import('@/managers/llm-manager.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockImplementation(async function(this: any, ...args: any[]) {
          const provider = args[0];
          await this.registry.getCompatModule(provider.compat);
          return mockResponse();
        });

      const registry = new PluginRegistry(pluginsDir);
      const coordinator = new LLMCoordinator(registry);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
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

  test('MCP-only run does not evaluate vector modules', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      // Explicitly allow MCP modules in this scenario (and avoid any network/process work).
      // These mocks also override the baseline/tools-only "throw on import" mocks.
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => ({
        parseMCPManifest: () => [{ id: 'local', command: 'node' }]
      }));
      jest.unstable_mockModule('../../../mcp/mcp-manifest.js', () => ({
        parseMCPManifest: () => [{ id: 'local', command: 'node' }]
      }));
      jest.unstable_mockModule('../../../mcp/mcp-client.js', () => ({
        MCPClientPool: class MCPClientPool {}
      }));
      jest.unstable_mockModule('../../../managers/mcp-manager.js', () => ({
        MCPManager: class MCPManager {
          constructor(private servers: any[]) {}

          getPool() {
            return undefined;
          }

          async gatherTools() {
            return [[], this.servers.map(s => s.id)];
          }

          async close() {}
        }
      }));

      jest.unstable_mockModule('../../../managers/vector-store-manager.js', () => {
        throw new Error('vector-store-manager should not be imported for MCP-only');
      });
      jest.unstable_mockModule('../../../managers/embedding-manager.js', () => {
        throw new Error('embedding-manager should not be imported for MCP-only');
      });
      jest.unstable_mockModule('../../../utils/vector/vector-context-injector.js', () => {
        throw new Error('vector-context-injector should not be imported for MCP-only');
      });

      const { PluginRegistry } = await import('@/core/registry.ts');
      const { LLMCoordinator } = await import('@/coordinator/coordinator.ts');
      const { LLMManager } = await import('@/managers/llm-manager.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockImplementation(async function(this: any, ...args: any[]) {
          const provider = args[0];
          await this.registry.getCompatModule(provider.compat);
          return mockResponse();
        });

      const registry = new PluginRegistry(pluginsDir);
      const coordinator = new LLMCoordinator(registry);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
        mcpServers: ['local'],
        settings: {}
      } as any);

      await coordinator.close();
    });
  });

  test('vector-context run does not evaluate MCP modules', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('mcp module should not be imported for vector-context-only');
      });
      jest.unstable_mockModule('../../../mcp/mcp-manifest.js', () => {
        throw new Error('mcp-manifest should not be imported for vector-context-only');
      });
      jest.unstable_mockModule('../../../mcp/mcp-client.js', () => {
        throw new Error('mcp-client should not be imported for vector-context-only');
      });
      jest.unstable_mockModule('../../../managers/mcp-manager.js', () => {
        throw new Error('mcp-manager should not be imported for vector-context-only');
      });

      let injectorImported = false;

      jest.unstable_mockModule('../../../managers/vector-store-manager.js', () => ({
        VectorStoreManager: class VectorStoreManager {
          // eslint-disable-next-line @typescript-eslint/no-useless-constructor
          constructor(..._args: any[]) {}
        }
      }));

      jest.unstable_mockModule('../../../managers/embedding-manager.js', () => ({
        EmbeddingManager: class EmbeddingManager {
          // eslint-disable-next-line @typescript-eslint/no-useless-constructor
          constructor(..._args: any[]) {}
        }
      }));

      jest.unstable_mockModule('../../../utils/vector/vector-context-injector.js', () => {
        injectorImported = true;
        return {
          VectorContextInjector: class VectorContextInjector {
            // eslint-disable-next-line @typescript-eslint/no-useless-constructor
            constructor(..._args: any[]) {}

            async injectContext(messages: any[]) {
              return { messages };
            }
          }
        };
      });

      const { PluginRegistry } = await import('@/core/registry.ts');
      const { LLMCoordinator } = await import('@/coordinator/coordinator.ts');
      const { LLMManager } = await import('@/managers/llm-manager.ts');

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockImplementation(async function(this: any, ...args: any[]) {
          const provider = args[0];
          await this.registry.getCompatModule(provider.compat);
          return mockResponse();
        });

      const registry = new PluginRegistry(pluginsDir);
      const coordinator = new LLMCoordinator(registry);

      await coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
        vectorContext: {
          mode: 'auto',
          stores: ['memory'],
          topK: 1
        },
        settings: {}
      } as any);

      expect(injectorImported).toBe(true);

      await coordinator.close();
    });
  });
});
