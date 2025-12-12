describe('package public exports', () => {
  test('root index exports server and coordinator surfaces', async () => {
    const module = await import('@/index.ts');
    expect(module.createServer).toBeDefined();
    expect(module.createServerHandlerWithDefaults).toBeDefined();
    expect(module.LLMCoordinator).toBeDefined();
  });
});

