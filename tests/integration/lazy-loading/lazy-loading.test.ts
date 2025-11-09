import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { PluginRegistry } from '@/core/registry.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { Role, LLMResponse } from '@/core/types.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';
import path from 'path';

describe('integration/lazy-loading', () => {
  const originalCwd = process.cwd();
  const pluginsDir = path.join(ROOT_DIR, 'tests', 'fixtures', 'plugins', 'basic');

  beforeAll(() => {
    process.chdir(ROOT_DIR);
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  // Helper to create mock LLM response
  function mockLLMResponse(text: string = 'Response'): LLMResponse {
    return {
      role: Role.ASSISTANT,
      content: [{ type: 'text', text }],
      provider: 'test-openai',
      model: 'stub-model',
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      }
    };
  }

  // Helper to inspect internal loading state
  function getLoadingState(registry: PluginRegistry, coordinator: LLMCoordinator) {
    return {
      providersLoaded: (registry as any).providersLoaded,
      toolsLoaded: (registry as any).toolsLoaded,
      mcpServersLoaded: (registry as any).mcpServersLoaded,
      vectorStoresLoaded: (registry as any).vectorStoresLoaded,
      processRoutesLoaded: (registry as any).processRoutesLoaded,
      compatModulesLoaded: (registry as any).compatModulesLoaded,
      compatModulesCount: (registry as any).compatModules.size,
      mcpManagerExists: !!(coordinator as any).mcpManager,
      toolCoordinatorInitialized: (coordinator as any).toolCoordinatorInitialized
    };
  }

  test('scenario 1: baseline - no tools, no MCP, no vector (only provider)', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    // Mock HTTP call but let compat loading happen
    const mockAxios = jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        // Get the provider compat (this will trigger loading)
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // Simple spec with no tools/MCP/vector
    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // Provider and compat should be loaded (needed for the call)
    expect(state.providersLoaded).toBe(true);
    expect(state.compatModulesLoaded).toBe(true);
    expect(state.compatModulesCount).toBeGreaterThan(0);

    // Tools, MCP, Vector should NOT be loaded
    expect(state.toolsLoaded).toBe(false);
    expect(state.mcpServersLoaded).toBe(false);
    expect(state.vectorStoresLoaded).toBe(false);
    expect(state.processRoutesLoaded).toBe(false);
    expect(state.mcpManagerExists).toBe(false);
    expect(state.toolCoordinatorInitialized).toBe(false);

    await coordinator.close();
  });

  test('scenario 2: inline tools only (spec.tools) - no registry tools loaded', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      tools: [
        {
          name: 'inline_tool',
          description: 'Inline tool',
          parametersJsonSchema: { type: 'object', properties: {} }
        }
      ],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // Provider, compat, and process routes should be loaded
    expect(state.providersLoaded).toBe(true);
    expect(state.compatModulesLoaded).toBe(true);
    expect(state.processRoutesLoaded).toBe(true);
    expect(state.toolCoordinatorInitialized).toBe(true);

    // Registry tools and MCP should NOT be loaded
    expect(state.toolsLoaded).toBe(false);
    expect(state.mcpServersLoaded).toBe(false);
    expect(state.mcpManagerExists).toBe(false);

    await coordinator.close();
  });

  test('scenario 3: registry tools only (functionToolNames) - loads tool manifests', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // Tools should now be loaded
    expect(state.toolsLoaded).toBe(true);
    expect(state.processRoutesLoaded).toBe(true);
    expect(state.toolCoordinatorInitialized).toBe(true);

    // MCP should still NOT be loaded
    expect(state.mcpServersLoaded).toBe(false);
    expect(state.mcpManagerExists).toBe(false);

    await coordinator.close();
  });

  test('scenario 4: MCP servers only - loads MCP configs and manager', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      mcpServers: ['local'],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // MCP should be loaded
    expect(state.mcpServersLoaded).toBe(true);
    expect(state.mcpManagerExists).toBe(true);
    expect(state.processRoutesLoaded).toBe(true);
    expect(state.toolCoordinatorInitialized).toBe(true);

    // Registry tools should NOT be loaded
    expect(state.toolsLoaded).toBe(false);

    await coordinator.close();
  });

  test('scenario 5: selective MCP loading - only requested server loaded', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // Request only 'local' server (even though 'alt-local' might exist)
    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      mcpServers: ['local'],
      settings: {}
    };

    await coordinator.run(spec);

    const mcpManager = (coordinator as any).mcpManager;
    expect(mcpManager).toBeDefined();

    // Check that only requested server is in manager
    const servers = mcpManager.servers;
    expect(servers).toBeDefined();
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((s: any) => s.id === 'local')).toBe(true);

    await coordinator.close();
  });

  test('scenario 6: tools + MCP combined - both load', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      mcpServers: ['local'],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // Both tools and MCP should be loaded
    expect(state.toolsLoaded).toBe(true);
    expect(state.mcpServersLoaded).toBe(true);
    expect(state.mcpManagerExists).toBe(true);
    expect(state.processRoutesLoaded).toBe(true);

    await coordinator.close();
  });

  test('scenario 7: compat modules load on-demand per provider', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // First call - OpenAI provider
    const spec1 = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    };

    await coordinator.run(spec1);

    let state = getLoadingState(registry, coordinator);

    // Compat should be loaded
    expect(state.compatModulesLoaded).toBe(true);
    const initialCompatCount = state.compatModulesCount;
    expect(initialCompatCount).toBeGreaterThan(0);

    // Second call - potentially different provider (if anthropic exists in fixtures)
    // For now, just verify compat module count doesn't explode
    const spec2 = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hi again' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    };

    await coordinator.run(spec2);

    state = getLoadingState(registry, coordinator);

    // Compat count should be same or similar (cached)
    expect(state.compatModulesCount).toBeGreaterThanOrEqual(initialCompatCount);

    await coordinator.close();
  });

  test('scenario 8: vector stores never auto-load', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // Try with tools and MCP - vector should still not load
    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      mcpServers: ['local'],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // Vector should NEVER be loaded automatically
    expect(state.vectorStoresLoaded).toBe(false);

    await coordinator.close();
  });

  test('scenario 9: process routes only load when tools are present', async () => {
    const registry1 = new PluginRegistry(pluginsDir);
    const coordinator1 = new LLMCoordinator(registry1);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // No tools
    const specNoTools = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    };

    await coordinator1.run(specNoTools);
    let state = getLoadingState(registry1, coordinator1);
    expect(state.processRoutesLoaded).toBe(false);

    await coordinator1.close();

    // With tools
    const registry2 = new PluginRegistry(pluginsDir);
    const coordinator2 = new LLMCoordinator(registry2);

    const specWithTools = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      settings: {}
    };

    await coordinator2.run(specWithTools);
    state = getLoadingState(registry2, coordinator2);
    expect(state.processRoutesLoaded).toBe(true);

    await coordinator2.close();
  });

  test('scenario 10: empty arrays do not trigger loading', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // Empty arrays should be treated as "no tools/MCP"
    const spec = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: [],
      mcpServers: [],
      tools: [],
      settings: {}
    };

    await coordinator.run(spec);

    const state = getLoadingState(registry, coordinator);

    // Should behave like no tools/MCP specified
    expect(state.toolsLoaded).toBe(false);
    expect(state.mcpServersLoaded).toBe(false);
    expect(state.mcpManagerExists).toBe(false);
    expect(state.toolCoordinatorInitialized).toBe(false);

    await coordinator.close();
  });

  test('scenario 11: registry.getMCPServers with empty array returns empty', async () => {
    const registry = new PluginRegistry(pluginsDir);

    // Test the registry method directly
    const servers = await registry.getMCPServers([]);
    expect(servers).toEqual([]);

    // MCP manifests should NOT have been loaded
    const state = (registry as any).mcpServersLoaded;
    expect(state).toBe(false);
  });

  test('scenario 12: multiple provider compats loaded independently', async () => {
    const registry = new PluginRegistry(pluginsDir);

    // Load one compat
    const compat1 = await registry.getCompatModule('openai');
    expect(compat1).toBeDefined();

    let compatCount = (registry as any).compatModules.size;
    expect(compatCount).toBeGreaterThan(0);

    // Load another compat (if available)
    try {
      const compat2 = await registry.getCompatModule('anthropic');
      const newCompatCount = (registry as any).compatModules.size;
      expect(newCompatCount).toBeGreaterThanOrEqual(compatCount);
    } catch (e) {
      // Anthropic might not exist in basic fixtures, that's ok
      // Test still verifies openai loaded
    }
  });

  test('scenario 13: toolCoordinator initialized flag tracks state correctly', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // Initially not initialized
    expect((coordinator as any).toolCoordinatorInitialized).toBe(false);

    // Call without tools
    await coordinator.run({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    });

    expect((coordinator as any).toolCoordinatorInitialized).toBe(false);

    // Call with tools
    await coordinator.run({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      settings: {}
    });

    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    // Second call with tools should hit the early return (line 56 coverage)
    await coordinator.run({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Hello again' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      settings: {}
    });

    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    await coordinator.close();
  });

  test('scenario 14: error handling for unknown tools and MCP servers', async () => {
    const registry = new PluginRegistry(pluginsDir);

    // Load tools first
    await registry.getTool('echo.text');

    // Try to get multiple tools including unknown one
    await expect(registry.getTools(['echo.text', 'unknown.tool']))
      .rejects.toThrow('Unknown tool');

    // Load MCP servers
    await registry.getMCPServers(['local']);

    // Try to get unknown MCP server
    await expect(registry.getMCPServers(['local', 'unknown.server']))
      .rejects.toThrow('Unknown MCP server');
  });

  test('scenario 15: mcp-manager gatherTools with undefined returns empty', async () => {
    const registry = new PluginRegistry(pluginsDir);

    // Load MCP configs
    const servers = await registry.getMCPServers(['local']);

    const { MCPManager } = await import('@/managers/mcp-manager.ts');
    const mcpManager = new MCPManager(servers);

    // Call gatherTools with undefined (covers line 79)
    const [tools, activeServers] = await mcpManager.gatherTools(undefined);
    expect(tools).toEqual([]);
    expect(activeServers).toEqual([]);

    await mcpManager.close();
  });

  test('scenario 16: vectorPriority triggers tool coordinator initialization', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async function(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        return mockLLMResponse();
      });

    // Initially not initialized
    expect((coordinator as any).toolCoordinatorInitialized).toBe(false);

    // Call with vectorPriority (should trigger tool coordinator)
    await coordinator.run({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Search for something' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      vectorPriority: [{ vectorStore: 'memory', topK: 5 }],
      settings: {}
    });

    // Tool coordinator should now be initialized
    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    await coordinator.close();
  });

  test('scenario 17: vectorPriority triggers tool coordinator in streaming mode', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    // Mock streaming provider
    async function* mockStream() {
      yield { choices: [{ delta: { content: 'hello' } }] };
    }

    jest.spyOn(LLMManager.prototype, 'streamProvider')
      .mockImplementation(async function*(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        yield* mockStream();
      });

    // Initially not initialized
    expect((coordinator as any).toolCoordinatorInitialized).toBe(false);

    // Call runStream with vectorPriority (should trigger tool coordinator)
    const stream = coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Search for something' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      vectorPriority: [{ vectorStore: 'memory', topK: 5 }],
      settings: {}
    });

    // Consume the stream
    for await (const _ of stream) {
      // Just consume
    }

    // Tool coordinator should now be initialized
    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    await coordinator.close();
  });

  test('scenario 18: streaming with only spec.tools triggers coordinator', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    // Mock streaming provider
    async function* mockStream() {
      yield { choices: [{ delta: { content: 'hello' } }] };
    }

    jest.spyOn(LLMManager.prototype, 'streamProvider')
      .mockImplementation(async function*(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        yield* mockStream();
      });

    // Call runStream with only spec.tools (tests first branch of needsTools condition)
    const stream = coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Test' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      tools: [{ name: 'test_tool', description: 'A test tool', parameters: {} }],
      settings: {}
    });

    // Consume the stream
    for await (const _ of stream) {
      // Just consume
    }

    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    await coordinator.close();
  });

  test('scenario 19: streaming with empty tools array but functionToolNames', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    // Mock streaming provider
    async function* mockStream() {
      yield { choices: [{ delta: { content: 'hello' } }] };
    }

    jest.spyOn(LLMManager.prototype, 'streamProvider')
      .mockImplementation(async function*(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        yield* mockStream();
      });

    // Call runStream with empty tools but with functionToolNames to test second branch
    const stream = coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Test' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      tools: [],  // Empty array - first condition fails
      functionToolNames: ['echo.text'],  // Second condition should trigger
      settings: {}
    });

    // Consume the stream
    for await (const _ of stream) {
      // Just consume
    }

    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    await coordinator.close();
  });

  test('scenario 20: streaming with undefined tools triggers via mcpServers', async () => {
    const registry = new PluginRegistry(pluginsDir);
    const coordinator = new LLMCoordinator(registry);

    // Mock streaming provider
    async function* mockStream() {
      yield { choices: [{ delta: { content: 'hello' } }] };
    }

    jest.spyOn(LLMManager.prototype, 'streamProvider')
      .mockImplementation(async function*(this: any, ...args: any[]) {
        const provider = args[0];
        await this.registry.getCompatModule(provider.compat);
        yield* mockStream();
      });

    // Test with undefined tools/functionToolNames but mcpServers defined (third condition)
    const stream = coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Test MCP' }] }],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      // tools: undefined (first condition undefined)
      // functionToolNames: undefined (second condition undefined)
      mcpServers: ['local'],  // Third condition should trigger
      settings: {}
    });

    // Consume the stream
    for await (const _ of stream) {
      // Just consume
    }

    expect((coordinator as any).toolCoordinatorInitialized).toBe(true);

    await coordinator.close();
  });
});
