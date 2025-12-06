/**
 * Unit tests for live test configuration filtering
 * Tests the getFilteredTestRuns() function which filters providers based on
 * LLM_TEST_PROVIDERS environment variable.
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
      expect(result.length).toBe(4);
    });

    test('returns all test runs when LLM_TEST_PROVIDERS is empty string', async () => {
      process.env.LLM_TEST_PROVIDERS = '';
      const { getFilteredTestRuns, testRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result).toEqual(testRuns);
    });

    test('filters to single provider when specified', async () => {
      process.env.LLM_TEST_PROVIDERS = 'anthropic';
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('anthropic');
    });

    test('filters to multiple providers when comma-separated', async () => {
      process.env.LLM_TEST_PROVIDERS = 'anthropic,google';
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(2);
      expect(result.map(r => r.name)).toContain('anthropic');
      expect(result.map(r => r.name)).toContain('google');
    });

    test('handles whitespace in comma-separated list', async () => {
      process.env.LLM_TEST_PROVIDERS = ' anthropic , google ';
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(2);
      expect(result.map(r => r.name)).toContain('anthropic');
      expect(result.map(r => r.name)).toContain('google');
    });

    test('is case-insensitive for provider names', async () => {
      process.env.LLM_TEST_PROVIDERS = 'ANTHROPIC,Google';
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(2);
      expect(result.map(r => r.name)).toContain('anthropic');
      expect(result.map(r => r.name)).toContain('google');
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

    test('handles openai-responses provider name correctly', async () => {
      process.env.LLM_TEST_PROVIDERS = 'openai-responses';
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('openai-responses');
    });

    test('handles openrouter provider name correctly', async () => {
      process.env.LLM_TEST_PROVIDERS = 'openrouter';
      const { getFilteredTestRuns } = await import('@tests/live/config.ts');

      const result = getFilteredTestRuns();
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('openrouter');
    });
  });

  describe('filteredTestRuns export', () => {
    test('is pre-computed at module load time', async () => {
      process.env.LLM_TEST_PROVIDERS = 'anthropic';
      const { filteredTestRuns } = await import('@tests/live/config.ts');

      expect(filteredTestRuns.length).toBe(1);
      expect(filteredTestRuns[0].name).toBe('anthropic');
    });
  });

  describe('timeout configuration', () => {
    test('timeout multiplier reflects filtered provider count', async () => {
      process.env.LLM_TEST_PROVIDERS = 'anthropic';
      const { timeoutMultiplier } = await import('@tests/live/config.ts');

      expect(timeoutMultiplier).toBe(1);
    });

    test('total timeout scales with filtered provider count', async () => {
      process.env.LLM_TEST_PROVIDERS = 'anthropic,google';
      const { totalTestTimeout, baseTestTimeout } = await import('@tests/live/config.ts');

      expect(totalTestTimeout).toBe(baseTestTimeout * 2);
    });
  });

  describe('backwards compatibility exports', () => {
    test('llmPriority still exports from first testRun', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { llmPriority } = await import('@tests/live/config.ts');

      expect(llmPriority).toBeDefined();
      expect(llmPriority[0].provider).toBe('anthropic');
    });

    test('defaultSettings still exports from first testRun', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { defaultSettings } = await import('@tests/live/config.ts');

      expect(defaultSettings).toBeDefined();
      expect(defaultSettings.temperature).toBe(0.3);
      expect(defaultSettings.maxTokens).toBe(60000);
    });

    test('primaryProvider still exports from first testRun', async () => {
      delete process.env.LLM_TEST_PROVIDERS;
      const { primaryProvider } = await import('@tests/live/config.ts');

      expect(primaryProvider).toBe('anthropic');
    });
  });
});
