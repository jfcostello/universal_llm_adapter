/**
 * Live Integration Test Configuration
 *
 * Centralized configuration for all live integration tests.
 * Each test run uses a different provider/model combination.
 */

export interface TestRun {
  name: string;
  llmPriority: Array<{ provider: string; model: string }>;
  settings: {
    temperature: number;
    maxTokens: number;
    reasoning?: {
      enabled: boolean;
      budget?: number;
    };
  };
}

/**
 * Test runs - each run uses a different provider configuration.
 * All live tests will execute once per run.
 */
export const testRuns: TestRun[] = [
  {
    name: 'anthropic',
    llmPriority: [
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5'
      }
    ],
    settings: {
      temperature: 1,
      maxTokens: 60000
    }
  },
  {
    name: 'openai-responses',
    llmPriority: [
      {
        provider: 'openai-responses',
        model: 'gpt-4o-mini'
      }
    ],
    settings: {
      temperature: 1,
      maxTokens: 60000
    }
  },
  {
    name: 'openrouter',
    llmPriority: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.0-flash-001'
      }
    ],
    settings: {
      temperature: 1,
      maxTokens: 60000
    }
  },
  {
    name: 'google',
    llmPriority: [
      {
        provider: 'google',
        model: 'gemini-2.5-flash'
      }
    ],
    settings: {
      temperature: 1,
      maxTokens: 60000
    }
  }
];

// Backwards compatibility exports (use first run as default)
export const llmPriority = testRuns[0].llmPriority;
export const defaultSettings = testRuns[0].settings;
export const primaryProvider = llmPriority[0]?.provider ?? '';

export const invalidPriorityEntry = {
  provider: primaryProvider,
  model: 'fakemodel/fakename'
};

/**
 * Timeout configuration - automatically scales with number of providers.
 * Base timeout is per-provider, total timeout is multiplied by provider count.
 *
 * Examples:
 * - 2 providers: 60s * 2 = 120s total timeout per test
 * - 3 providers: 600s * 3 = 180s total timeout per test
 */
export const baseTestTimeout = 120000; // 120 seconds per provider
export const timeoutMultiplier = testRuns.length;
export const totalTestTimeout = baseTestTimeout * timeoutMultiplier;
