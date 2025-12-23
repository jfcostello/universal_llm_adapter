import { getMissingRequiredEnv, getTestPathPatternsFromJestArgs } from '../../live/required-env.ts';

describe('live/required-env', () => {
  test('getTestPathPatternsFromJestArgs parses --testPathPattern= form', () => {
    const patterns = getTestPathPatternsFromJestArgs([
      'jest.js',
      '--testPathPattern=live',
      '--maxWorkers=2'
    ]);
    expect(patterns).toEqual(['live']);
  });

  test('getTestPathPatternsFromJestArgs parses --testPathPattern <value> form', () => {
    const patterns = getTestPathPatternsFromJestArgs([
      'jest.js',
      '--testPathPattern',
      '15-embeddings'
    ]);
    expect(patterns).toEqual(['15-embeddings']);
  });

  test('getMissingRequiredEnv requires provider key for selected providers (openrouter)', () => {
    const missing = getMissingRequiredEnv({
      selectedProviders: ['openrouter'],
      testPathPatterns: ['00-foundation'],
      env: {}
    });
    expect(missing).toEqual(['OPENROUTER_API_KEY']);
  });

  test('getMissingRequiredEnv requires provider key for selected providers (openai)', () => {
    const missing = getMissingRequiredEnv({
      selectedProviders: ['openai'],
      testPathPatterns: ['20-realtime'],
      env: {}
    });
    expect(missing).toEqual(['OPENAI_API_KEY']);
  });

  test('getMissingRequiredEnv requires OpenRouter key for embeddings suite', () => {
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['15-embeddings'],
      env: {}
    });
    expect(missing).toEqual(['OPENROUTER_API_KEY']);
  });

  test('getMissingRequiredEnv requires Qdrant + OpenRouter keys for vector suites', () => {
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['16-vector-store'],
      env: { OPENROUTER_API_KEY: 'x' }
    });
    expect(missing).toEqual(['QDRANT_CLOUD_URL', 'QDRANT_API_KEY']);
  });

  test('getMissingRequiredEnv requires Qdrant + OpenRouter keys for full live suite', () => {
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['live'],
      env: {}
    });
    expect(missing).toEqual(['OPENROUTER_API_KEY', 'QDRANT_CLOUD_URL', 'QDRANT_API_KEY']);
  });

  test('getMissingRequiredEnv does not require Langfuse keys when observabilityTestProvider is null', () => {
    // With observabilityTestProvider = null (default), no Langfuse keys should be required
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['21-observability'],
      env: {}
    });
    // Should not include LANGFUSE_SECRET_KEY or LANGFUSE_PUBLIC_KEY
    expect(missing).not.toContain('LANGFUSE_SECRET_KEY');
    expect(missing).not.toContain('LANGFUSE_PUBLIC_KEY');
  });

  test('getMissingRequiredEnv does not require Langfuse keys for non-observability patterns', () => {
    const missing = getMissingRequiredEnv({
      selectedProviders: [],
      testPathPatterns: ['05-streaming-core'],
      env: {}
    });
    expect(missing).not.toContain('LANGFUSE_SECRET_KEY');
    expect(missing).not.toContain('LANGFUSE_PUBLIC_KEY');
  });
});

