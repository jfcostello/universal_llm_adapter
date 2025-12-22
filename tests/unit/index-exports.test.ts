describe('package public exports', () => {
  test('root index exports kernel-only surface (no feature exports)', async () => {
    const module = await import('@/index.ts');

    // Kernel exports
    expect(module.PluginRegistry).toBeDefined();
    expect(module.getDefaults).toBeDefined();
    expect(module.ManifestError).toBeDefined();

    // Feature exports must not be present at the root.
    expect((module as any).createServer).toBeUndefined();
    expect((module as any).createServerHandlerWithDefaults).toBeUndefined();
    expect((module as any).LLMCoordinator).toBeUndefined();
    expect((module as any).VectorStoreCoordinator).toBeUndefined();
    expect((module as any).EmbeddingCoordinator).toBeUndefined();
  });
});
