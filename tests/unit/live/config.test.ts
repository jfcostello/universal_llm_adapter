/**
 * Unit tests for live test configuration filtering
 * Tests the getFilteredTestRuns() function which filters providers based on
 * LLM_TEST_PROVIDERS environment variable.
 *
 * NOTE: These tests focus on the BEHAVIOR of filtering, not specific config values.
 * This allows the config to be modified without breaking tests.
 */
import { jest } from '@jest/globals';

describe('tests/live/config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe('getFilteredTestRuns', () => {
    test('returns all test runs when LLM_TEST_PROVIDERS is not set', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { getFilteredTestRuns, testRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result).toEqual(testRuns);
      expect(result.length).toBe(testRuns.length);
    });

    test('returns all test runs when LLM_TEST_PROVIDERS is empty string', async () => {
      process.env.LLM_TEST_PROVIDERS = '';
      const { getFilteredTestRuns, testRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result).toEqual(testRuns);
    });

    test('filters to single provider when specified', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');
      const firstProviderName = testRuns[0].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = firstProviderName;
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(1);
      expect(result[0].name).toBe(firstProviderName);
    });

    test('filters to multiple providers when comma-separated', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');

      if (testRuns.length < 2) {
        return; // Skip if not enough providers configured
      }

      const provider1 = testRuns[0].name;
      const provider2 = testRuns[1].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = `${provider1},${provider2}`;
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(2);
      expect(result.map(r => r.name)).toContain(provider1);
      expect(result.map(r => r.name)).toContain(provider2);
    });

    test('handles whitespace in comma-separated list', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');

      if (testRuns.length < 2) {
        return; // Skip if not enough providers configured
      }

      const provider1 = testRuns[0].name;
      const provider2 = testRuns[1].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = ` ${provider1} , ${provider2} `;
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(2);
      expect(result.map(r => r.name)).toContain(provider1);
      expect(result.map(r => r.name)).toContain(provider2);
    });

    test('is case-insensitive for provider names', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');

      if (testRuns.length < 2) {
        return; // Skip if not enough providers configured
      }

      const provider1 = testRuns[0].name;
      const provider2 = testRuns[1].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = `${provider1.toUpperCase()},${provider2.charAt(0).toUpperCase() + provider2.slice(1)}`;
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(2);
      expect(result.map(r => r.name)).toContain(provider1);
      expect(result.map(r => r.name)).toContain(provider2);
    });

    test('returns all test runs with warning when no providers match', async () => {
      process.env.LLM_TEST_PROVIDERS = 'nonexistent';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { getFilteredTestRuns, testRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result).toEqual(testRuns);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No test runs matched providers: nonexistent')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Available:')
      );

      warnSpy.mockRestore();
    });

    test('filters correctly for any provider in testRuns', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');

      // Test filtering works for each configured provider
      for (const run of testRuns) {
        jest.resetModules();
        process.env.LLM_TEST_PROVIDERS = run.name;
        const { getFilteredTestRuns } = await import('@tests/live/config.ts');

        const result = getFilteredTestRuns();
        expect(result.length).toBe(1);
        expect(result[0].name).toBe(run.name);
      }
    });
  });

  describe('filteredTestRuns export', () => {
    test('is pre-computed at module load time based on env var', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');
      const firstProviderName = testRuns[0].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = firstProviderName;
      const { filteredTestRuns } = await import('@tests/live/config.ts');

      expect(filteredTestRuns.length).toBe(1);
      expect(filteredTestRuns[0].name).toBe(firstProviderName);
    });
  });

  describe('timeout configuration', () => {
    test('timeout multiplier reflects filtered provider count', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');
      const firstProviderName = testRuns[0].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = firstProviderName;
      const { timeoutMultiplier } = await import('@tests/live/config.ts');

      expect(timeoutMultiplier).toBe(1);
    });

    test('total timeout scales with filtered provider count', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { testRuns } = await import('@tests/live/config.ts');

      if (testRuns.length < 2) {
        return; // Skip if not enough providers configured
      }

      const provider1 = testRuns[0].name;
      const provider2 = testRuns[1].name;

      jest.resetModules();
      process.env.LLM_TEST_PROVIDERS = `${provider1},${provider2}`;
      const { totalTestTimeout, baseTestTimeout } = await import('@tests/live/config.ts');

      expect(totalTestTimeout).toBe(baseTestTimeout * 2);
    });
  });

  describe('backwards compatibility exports', () => {
    test('llmPriority exports from first testRun', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { llmPriority, testRuns } = await import('@tests/live/config.ts');

      expect(llmPriority).toBeDefined();
      expect(llmPriority).toEqual(testRuns[0].llmPriority);
    });

    test('defaultSettings exports from first testRun', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { defaultSettings, testRuns } = await import('@tests/live/config.ts');

      expect(defaultSettings).toBeDefined();
      expect(defaultSettings).toEqual(testRuns[0].settings);
    });

    test('primaryProvider exports from first testRun', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { primaryProvider, testRuns } = await import('@tests/live/config.ts');

      expect(primaryProvider).toBe(testRuns[0].llmPriority[0]?.provider ?? '');
    });
  });
});
