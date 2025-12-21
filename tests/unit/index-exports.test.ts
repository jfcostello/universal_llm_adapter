describe('package public exports', () => {
  test('root index exports all public modules', async () => {
    const module = await import('@/index.ts');

    // Kernel exports
    expect(module.PluginRegistry).toBeDefined();
    expect(module.getDefaults).toBeDefined();
    expect(module.ManifestError).toBeDefined();

    // LLM module exports
    expect(module.LLMCoordinator).toBeDefined();
    expect(module.LLMManager).toBeDefined();

    // Server module exports
    expect(module.createServer).toBeDefined();
    expect(module.createServerHandlerWithDefaults).toBeDefined();

    // Vector module exports
    expect(module.VectorStoreCoordinator).toBeDefined();

    // Embeddings module exports
    expect(module.EmbeddingCoordinator).toBeDefined();

    // Realtime module exports
    expect(module.createRealtimeSession).toBeDefined();

    // Audio module exports
    expect(module.base64ToBytes).toBeDefined();
    expect(module.bytesToBase64).toBeDefined();

    // MCP module exports
    expect(module.MCPConnection).toBeDefined();
    expect(module.MCPClientPool).toBeDefined();

    // Tools module exports
    expect(module.ToolCoordinator).toBeDefined();

    // Logging module exports (excluding AdapterLogger class to avoid kernel conflict)
    expect(module.getLLMLogger).toBeDefined();
    expect(module.LLMLogger).toBeDefined();
    expect(module.closeLogger).toBeDefined();

    // CLI module exports
    expect(module.runUnifiedCli).toBeDefined();
  });

  test('AdapterLogger from root is the kernel interface (not the logging class)', async () => {
    const module = await import('@/index.ts');

    // AdapterLogger should be the kernel's interface type, not the logging class
    // This verifies we correctly handle the naming conflict
    expect(module.AdapterLogger).toBeUndefined(); // Interface only, not runtime value
  });
});
