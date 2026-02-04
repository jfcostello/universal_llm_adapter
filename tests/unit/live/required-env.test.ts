describe('live/required-env', () => {
  test('getTestPathPatternsFromJestArgs parses --testPathPattern= form', async () => {
    const { getTestPathPatternsFromJestArgs } = await import('../../live/required-env.ts');
    const patterns = getTestPathPatternsFromJestArgs([
      'jest.js',
      '--testPathPattern=live'
    ]);
    expect(patterns).toEqual(['live']);
  });

  test('getTestPathPatternsFromJestArgs parses --testPathPattern <value> form', async () => {
    const { getTestPathPatternsFromJestArgs } = await import('../../live/required-env.ts');
    const patterns = getTestPathPatternsFromJestArgs([
      'jest.js',
      '--testPathPattern',
      '15-embeddings'
    ]);
    expect(patterns).toEqual(['15-embeddings']);
  });

  test('getMissingRequiredEnv requires provider key for selected providers (openrouter)', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: ['openrouter'],
      testPathPatterns: ['00-foundation'],
      env: {}
    });
    // Langfuse keys are required for LLM live runs when observability provider is langfuse.
    expect(missing).toEqual(['OPENROUTER_API_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']);
  });

  test('getMissingRequiredEnv requires provider key for selected providers (openai)', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: ['openai'],
      testPathPatterns: ['20-realtime'],
      env: {}
    });
    expect(missing).toEqual(['OPENAI_API_KEY']);
  });

  test('getMissingRequiredEnv requires assistantId for selected providers (openai-assistants)', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: ['openai-assistants'],
      testPathPatterns: ['00-foundation'],
      env: {}
    });
    // Langfuse keys are required for LLM live runs when observability provider is langfuse.
    expect(missing).toEqual([
      'OPENAI_API_KEY',
      'OPENAI_ASSISTANTS_ASSISTANT_ID',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY'
    ]);
  });

  test('getMissingRequiredEnv requires provider key for selected providers (grok)', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: ['grok'],
      testPathPatterns: ['20-realtime'],
      env: {}
    });
    expect(missing).toEqual(['XAI_API_KEY']);
  });

  test('getMissingRequiredEnv requires OpenRouter key for embeddings suite', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['15-embeddings'],
      env: {}
    });
    expect(missing).toEqual(['OPENROUTER_API_KEY']);
  });

  test('getMissingRequiredEnv requires Qdrant + OpenRouter keys for vector suites', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['16-vector-store'],
      env: { OPENROUTER_API_KEY: 'x' }
    });
    expect(missing).toEqual(['QDRANT_CLOUD_URL', 'QDRANT_API_KEY']);
  });

  test('getMissingRequiredEnv requires Qdrant + OpenRouter keys for full live suite', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['live'],
      env: {}
    });
    expect(missing).toEqual([
      'OPENROUTER_API_KEY',
      'QDRANT_CLOUD_URL',
      'QDRANT_API_KEY',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
      'SENTRY_API_KEY',
      'SENTRY_ORG_SLUG',
      'SENTRY_PROJECT_SLUG'
    ]);
  });

  test('getMissingRequiredEnv does not require Langfuse keys for embeddings-only patterns', async () => {
    const { getMissingRequiredEnv } = await import('../../live/required-env.ts');
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['15-embeddings'],
      env: {}
    });
    expect(missing).not.toContain('LANGFUSE_SECRET_KEY');
    expect(missing).not.toContain('LANGFUSE_PUBLIC_KEY');
  });
});
