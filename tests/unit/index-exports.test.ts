describe('package public exports', () => {
  test('root index exposes call-based switchboard functions only', async () => {
    const module = await import('@/index.ts');

    // CLI
    expect(typeof module.runUnifiedCli).toBe('function');

    // Defaults
    expect(typeof module.getDefaults).toBe('function');

    // Server
    expect(typeof module.createServer).toBe('function');
    expect(typeof module.createServerHandlerWithDefaults).toBe('function');

    // Lifecycle helpers (used by both CLI and server)
    expect(typeof module.createRegistry).toBe('function');
    expect(typeof module.createLlmCoordinator).toBe('function');
    expect(typeof module.createVectorCoordinator).toBe('function');
    expect(typeof module.createEmbeddingCoordinator).toBe('function');
    expect(typeof module.runWithCoordinatorLifecycle).toBe('function');
    expect(typeof module.streamWithCoordinatorLifecycle).toBe('function');
    expect(typeof module.closeLogger).toBe('function');

    // Realtime
    expect(typeof module.createRealtimeSession).toBe('function');
    expect(typeof module.createWsTransport).toBe('function');

    // Root must not export classes (keep programmatic API call-based).
    expect(module.PluginRegistry).toBeUndefined();
    expect(module.LLMCoordinator).toBeUndefined();
    expect(module.VectorStoreCoordinator).toBeUndefined();
    expect(module.EmbeddingCoordinator).toBeUndefined();
    expect(module.ToolCoordinator).toBeUndefined();
    expect(module.MCPConnection).toBeUndefined();
    expect(module.LLMLogger).toBeUndefined();
  });

  test('root does not export AdapterLogger runtime values', async () => {
    const module = await import('@/index.ts');

    expect(module.AdapterLogger).toBeUndefined();
  });
});
