
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

export interface RealtimeTestRun {
  name: string;
  provider: string;
  model: string;
}

/**
 * All available test runs - each run uses a different provider configuration.
 * Use getFilteredTestRuns() or filteredTestRuns to respect LLM_TEST_PROVIDERS filtering.
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
      temperature: 0.3,
      maxTokens: 60000
    }
  },
  {
    name: 'openai-responses',
    llmPriority: [
      {
        provider: 'openai-responses',
        model: 'gpt-4.1-mini'
      }
    ],
    settings: {
      temperature: 0.3,
      maxTokens: 60000
    }
  },
  {
    name: 'openrouter',
    llmPriority: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3-pro-preview'
      }
    ],
    settings: {
      temperature: 0.3,
      maxTokens: 60000
    }
  },
  {
    name: 'google',
    llmPriority: [
      {
        provider: 'google',
        model: 'gemini-3-pro-preview'
      }
    ],
    settings: {
      temperature: 0.3,
      maxTokens: 60000
    }
  }
];

/**
 * All available realtime test runs - each run uses a different realtime provider configuration.
 * Use getFilteredRealtimeTestRuns() or filteredRealtimeTestRuns to respect LLM_TEST_PROVIDERS filtering.
 */
export const realtimeTestRuns: RealtimeTestRun[] = [
  {
    name: 'openai',
    provider: 'openai',
    model: 'gpt-realtime'
  },
  {
    name: 'google',
    provider: 'google',
    model: 'gemini-2.5-flash-native-audio-preview-12-2025'
  }
];

/**
 * Filter test runs based on LLM_TEST_PROVIDERS environment variable.
 * Allows running live tests for specific providers only.
 *
 * @example
 * // Run only anthropic tests:
 * LLM_TEST_PROVIDERS=anthropic npm run test:live
 *
 * @example
 * // Run anthropic and google tests:
 * LLM_TEST_PROVIDERS=anthropic,google npm run test:live
 *
 * @returns Filtered array of TestRun objects, or all testRuns if no filter specified
 */
export function getFilteredTestRuns(): TestRun[] {
  const providerFilter = process.env.LLM_TEST_PROVIDERS;
  if (!providerFilter || providerFilter.trim() === '') {
    return testRuns;
  }

  const requestedProviders = providerFilter.split(',').map(p => p.trim().toLowerCase());
  const filtered = testRuns.filter(run =>
    requestedProviders.includes(run.name.toLowerCase())
  );

  if (filtered.length === 0) {
    console.warn(
      `Warning: No test runs matched providers: ${providerFilter}. ` +
      `Available: ${testRuns.map(r => r.name).join(', ')}`
    );
    return testRuns;
  }

  return filtered;
}

/**
 * Filter realtime test runs based on LLM_TEST_PROVIDERS environment variable.
 * Allows running realtime live tests for specific providers only.
 *
 * @example
 * // Run only openai realtime tests:
 * LLM_TEST_PROVIDERS=openai npm run test:live:realtime
 */
export function getFilteredRealtimeTestRuns(): RealtimeTestRun[] {
  const providerFilter = process.env.LLM_TEST_PROVIDERS;
  if (!providerFilter || providerFilter.trim() === '') {
    return realtimeTestRuns;
  }

  const requestedProviders = providerFilter.split(',').map(p => p.trim().toLowerCase());
  const filtered = realtimeTestRuns.filter(run =>
    requestedProviders.includes(run.name.toLowerCase())
  );

  if (filtered.length === 0) {
    console.warn(
      `Warning: No realtime test runs matched providers: ${providerFilter}. ` +
      `Available: ${realtimeTestRuns.map(r => r.name).join(', ')}`
    );
    return [];
  }

  return filtered;
}

/**
 * Pre-computed filtered test runs based on LLM_TEST_PROVIDERS environment variable.
 * Use this in test files instead of testRuns to respect provider filtering.
 */
export const filteredTestRuns = getFilteredTestRuns();

/**
 * Pre-computed filtered realtime test runs based on LLM_TEST_PROVIDERS environment variable.
 * Use this in realtime test files instead of realtimeTestRuns to respect provider filtering.
 */
export const filteredRealtimeTestRuns = getFilteredRealtimeTestRuns();

// Backwards compatibility exports (use first run as default)
export const llmPriority = testRuns[0].llmPriority;
export const defaultSettings = testRuns[0].settings;
export const primaryProvider = llmPriority[0]?.provider ?? '';

export const invalidPriorityEntry = {
  provider: primaryProvider,
  model: 'fakemodel/fakename'
};

/**
 * Timeout configuration - automatically scales with number of filtered providers.
 * Base timeout is per-provider, total timeout is multiplied by filtered provider count.
 *
 * Examples:
 * - 1 provider (filtered): 120s * 1 = 120s total timeout per test
 * - 2 providers (filtered): 120s * 2 = 240s total timeout per test
 * - 4 providers (all): 120s * 4 = 480s total timeout per test
 */
export const baseTestTimeout = 120000; // 120 seconds per provider
export const timeoutMultiplier = filteredTestRuns.length;
export const totalTestTimeout = baseTestTimeout * timeoutMultiplier;

// Default Jest worker count for live runs (can be overridden via env/CLI)
export const maxWorkersDefault = 5;
