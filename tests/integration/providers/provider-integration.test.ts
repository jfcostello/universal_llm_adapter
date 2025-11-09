/**
 * Provider Integration Tests
 *
 * This file orchestrates integration tests for all provider compatibility modules.
 * Provider-specific tests are split into separate files for better organization and maintainability:
 *
 * Core test suites (representative coverage):
 * - openai-provider.test.ts: ~151 comprehensive tests for OpenAI compat
 * - anthropic-provider.test.ts: ~151 comprehensive tests for Anthropic compat
 * - google-provider.test.ts: ~152 comprehensive tests for Google compat (includes SDK tests)
 *
 * Extended test suites (all permutations):
 * - openai-provider-extended.test.ts: ~100 additional edge case/permutation tests
 * - anthropic-provider-extended.test.ts: ~100 additional edge case/permutation tests
 * - google-provider-extended.test.ts: ~150 additional edge case/permutation tests
 *
 * Total: ~805 provider integration tests
 *
 * This approach provides:
 * 1. Better code organization and navigation
 * 2. Complete permutation coverage across all providers
 * 3. Easier maintenance and updates
 * 4. Parallel test execution capability
 * 5. Every test from PROVIDER_INTEGRATION_TEST_SPECIFICATION.md implemented
 */

// Import all provider-specific test suites
import './openai-provider.test.ts';
import './anthropic-provider.test.ts';
import './google-provider.test.ts';

// Import extended test suites (all permutations)
import './openai-provider-extended.test.ts';
import './anthropic-provider-extended.test.ts';
import './google-provider-extended.test.ts';

// Additional integration tests that span multiple providers
import { jest } from '@jest/globals';
import OpenAICompat from '@/plugins/compat/openai.ts';

describe('integration/providers/cross-provider', () => {
  test('LLMManager maps provider retry words to rate-limit errors', async () => {
    const registry = {
      getCompatModule: () => new OpenAICompat()
    };

    const manager = new (await import('@/managers/llm-manager.ts')).LLMManager(registry as any);

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValue({
        status: 429,
        statusText: 'Too Many Requests',
        headers: {},
        data: { message: 'Rate limit exceeded' }
      });

    const manifest = {
      id: 'mock-openai',
      compat: 'openai',
      endpoint: {
        urlTemplate: 'https://example.com/{model}',
        method: 'POST',
        headers: {}
      },
      retryWords: ['rate limit']
    };

    await expect(
      manager.callProvider(manifest as any, 'stub', {}, [], [], 'auto', {}, undefined, undefined)
    ).rejects.toMatchObject({ isRateLimit: true });

    requestSpy.mockRestore();
  });
});
