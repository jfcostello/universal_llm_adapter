import { jest } from '@jest/globals';

describe('core/defaults', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  describe('getDefaults', () => {
    test('returns all default categories', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const defaults = getDefaults();

      // Verify all categories exist
      expect(defaults).toHaveProperty('retry');
      expect(defaults).toHaveProperty('tools');
      expect(defaults).toHaveProperty('vector');
      expect(defaults).toHaveProperty('chunking');
      expect(defaults).toHaveProperty('tokenEstimation');
      expect(defaults).toHaveProperty('timeouts');
      expect(defaults).toHaveProperty('server');
      expect(defaults).toHaveProperty('paths');
    });

    test('returns correct retry defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { retry } = getDefaults();

      expect(retry.maxAttempts).toBe(3);
      expect(retry.baseDelayMs).toBe(250);
      expect(retry.multiplier).toBe(2.0);
      expect(retry.rateLimitDelays).toEqual([1, 1, 5, 5, 5, 15, 15, 16, 30, 31, 61, 5, 5, 51]);
    });

    test('returns correct tools defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { tools } = getDefaults();

      expect(tools.countdownEnabled).toBe(true);
      expect(tools.finalPromptEnabled).toBe(true);
      expect(tools.parallelExecution).toBe(false);
      expect(tools.preserveResults).toBe(3);
      expect(tools.preserveReasoning).toBe(3);
      expect(tools.maxIterations).toBe(10);
      expect(tools.timeoutMs).toBe(120000);
    });

    test('returns correct vector defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { vector } = getDefaults();

      expect(vector.topK).toBe(5);
      expect(vector.injectTemplate).toBe('Relevant context:\n{{results}}');
      expect(vector.resultFormat).toBe('- {{payload.text}} (score: {{score}})');
      expect(vector.batchSize).toBe(10);
      expect(vector.includePayload).toBe(true);
      expect(vector.includeVector).toBe(false);
      expect(vector.defaultCollection).toBe('default');
    });

    test('returns correct chunking defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { chunking } = getDefaults();

      expect(chunking.size).toBe(500);
      expect(chunking.overlap).toBe(50);
    });

    test('returns correct tokenEstimation defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { tokenEstimation } = getDefaults();

      expect(tokenEstimation.textDivisor).toBe(4);
      expect(tokenEstimation.imageEstimate).toBe(768);
      expect(tokenEstimation.toolResultDivisor).toBe(6);
    });

    test('returns correct timeout defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { timeouts } = getDefaults();

      expect(timeouts.mcpRequest).toBe(30000);
      expect(timeouts.llmHttp).toBe(60000);
      expect(timeouts.embeddingHttp).toBe(60000);
      expect(timeouts.loggerFlush).toBe(2000);
    });

	    test('returns correct server defaults', async () => {
	      const { getDefaults } = await import('@/core/defaults.ts');
	      const { server } = getDefaults();
	
	      expect(server.maxRequestBytes).toBe(25 * 1024 * 1024);
	      expect(server.bodyReadTimeoutMs).toBe(10000);
	      expect(server.requestTimeoutMs).toBe(0);
	      expect(server.streamIdleTimeoutMs).toBe(60000);
	      expect(server.maxConcurrentRequests).toBe(128);
	      expect(server.maxConcurrentStreams).toBe(32);
	      expect(server.maxQueueSize).toBe(1000);
	      expect(server.queueTimeoutMs).toBe(30000);
	      expect(server.maxConcurrentVectorRequests).toBe(128);
	      expect(server.maxConcurrentVectorStreams).toBe(32);
	      expect(server.vectorMaxQueueSize).toBe(1000);
	      expect(server.vectorQueueTimeoutMs).toBe(30000);
	      expect(server.maxConcurrentEmbeddingRequests).toBe(128);
	      expect(server.embeddingMaxQueueSize).toBe(1000);
	      expect(server.embeddingQueueTimeoutMs).toBe(30000);
	      expect(server.auth.enabled).toBe(false);
	      expect(server.auth.allowBearer).toBe(true);
	      expect(server.auth.allowApiKeyHeader).toBe(true);
	      expect(server.rateLimit.enabled).toBe(false);
	      expect(server.cors.enabled).toBe(false);
	      expect(server.securityHeadersEnabled).toBe(true);
	    });

    test('returns correct paths defaults', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { paths } = getDefaults();

      expect(paths.plugins).toBe('./plugins');
    });

    test('caches defaults after first load', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');

      const first = getDefaults();
      const second = getDefaults();

      expect(first).toBe(second); // Same reference = cached
    });
  });

  describe('resetDefaultsCache', () => {
    test('clears cached defaults', async () => {
      const { getDefaults, resetDefaultsCache } = await import('@/core/defaults.ts');

      const first = getDefaults();
      resetDefaultsCache();
      const second = getDefaults();

      // Values should be equal but not same reference after reset
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });

  describe('loading from JSON file', () => {
    test('loads defaults from the project defaults.json file', async () => {
      // This test verifies the real defaults.json is loaded
      // (already verified in the getDefaults tests above, but this confirms the file loading path)
      jest.resetModules();
      const { getDefaults, resetDefaultsCache } = await import('@/core/defaults.ts');
      resetDefaultsCache();
      const defaults = getDefaults();

      // Should load the real defaults.json values (matching what we created)
      expect(defaults.retry.maxAttempts).toBe(3);
      expect(defaults.retry.baseDelayMs).toBe(250);
      expect(defaults.tools.countdownEnabled).toBe(true);
      expect(defaults.tools.maxIterations).toBe(10);
      expect(defaults.vector.topK).toBe(5);
      expect(defaults.chunking.size).toBe(500);
      expect(defaults.tokenEstimation.textDivisor).toBe(4);
      expect(defaults.timeouts.mcpRequest).toBe(30000);
      expect(defaults.paths.plugins).toBe('./plugins');
    });

    test('uses fallback when no JSON file exists (via module reimport with mocked fs)', async () => {
      jest.resetModules();

      const originalFs = await import('fs');

      // Mock fs.existsSync to always return false for defaults.json
      const fsMock: any = {
        __esModule: true,
        existsSync: jest.fn((path: string) => {
          if (path.includes('defaults.json')) {
            return false;
          }
          return originalFs.existsSync(path);
        }),
        readFileSync: originalFs.readFileSync
      };
      fsMock.default = fsMock;

      (jest as any).unstable_mockModule('fs', () => fsMock);

      const { getDefaults } = await import('@/core/defaults.ts');
      const defaults = getDefaults();

      // Should use fallback defaults (same values, but via fallback path)
      expect(defaults.retry.maxAttempts).toBe(3);
      expect(defaults.tools.countdownEnabled).toBe(true);
      expect(defaults.vector.topK).toBe(5);

      jest.resetModules();
    });

    test('uses fallback when JSON file is invalid (via module reimport with mocked fs)', async () => {
      jest.resetModules();

      const originalFs = await import('fs');

      // Mock fs to return true for existsSync but throw on loadJsonFile
      const fsMock: any = {
        __esModule: true,
        existsSync: jest.fn(() => true),
        readFileSync: jest.fn((path: string) => {
          if (path.includes('defaults.json')) {
            return '{ invalid json }';
          }
          return originalFs.readFileSync(path);
        })
      };
      fsMock.default = fsMock;

      (jest as any).unstable_mockModule('fs', () => fsMock);

      const { getDefaults } = await import('@/core/defaults.ts');
      const defaults = getDefaults();

      // Should use fallback defaults due to parse error
      expect(defaults.retry.maxAttempts).toBe(3);
      expect(defaults.tools.countdownEnabled).toBe(true);

      jest.resetModules();
    });
  });

  describe('type safety', () => {
    test('DefaultSettings interface has all required properties', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const defaults = getDefaults();

      // TypeScript would catch missing properties at compile time,
      // but we verify runtime structure here
      const requiredKeys = ['retry', 'tools', 'vector', 'chunking', 'tokenEstimation', 'timeouts', 'server', 'paths'];
      for (const key of requiredKeys) {
        expect(defaults).toHaveProperty(key);
        expect(defaults[key as keyof typeof defaults]).toBeDefined();
      }
    });

    test('retry defaults have correct types', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { retry } = getDefaults();

      expect(typeof retry.maxAttempts).toBe('number');
      expect(typeof retry.baseDelayMs).toBe('number');
      expect(typeof retry.multiplier).toBe('number');
      expect(Array.isArray(retry.rateLimitDelays)).toBe(true);
      expect(retry.rateLimitDelays.every((n: number) => typeof n === 'number')).toBe(true);
    });

    test('tools defaults have correct types', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { tools } = getDefaults();

      expect(typeof tools.countdownEnabled).toBe('boolean');
      expect(typeof tools.finalPromptEnabled).toBe('boolean');
      expect(typeof tools.parallelExecution).toBe('boolean');
      expect(typeof tools.preserveResults).toBe('number');
      expect(typeof tools.preserveReasoning).toBe('number');
      expect(typeof tools.maxIterations).toBe('number');
      expect(typeof tools.timeoutMs).toBe('number');
    });

    test('vector defaults have correct types', async () => {
      const { getDefaults } = await import('@/core/defaults.ts');
      const { vector } = getDefaults();

      expect(typeof vector.topK).toBe('number');
      expect(typeof vector.injectTemplate).toBe('string');
      expect(typeof vector.resultFormat).toBe('string');
      expect(typeof vector.batchSize).toBe('number');
      expect(typeof vector.includePayload).toBe('boolean');
      expect(typeof vector.includeVector).toBe('boolean');
      expect(typeof vector.defaultCollection).toBe('string');
    });
  });
});
