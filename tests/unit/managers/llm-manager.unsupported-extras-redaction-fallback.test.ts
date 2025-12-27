import { describe, expect, test, jest } from '@jest/globals';
import { Role } from '@/kernel/index.ts';

async function loadLlmModule() {
  return import('@/modules/llm/index.ts');
}

describe('LLMManager unsupported extras redaction fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('logs "***" when redaction throws', async () => {
    (jest as any).unstable_mockModule('@/modules/security/index.ts', () => ({
      redactJsonCredentials: () => {
        throw new Error('Redaction failed');
      }
    }));

    const { LLMManager } = await loadLlmModule();

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'SDK response' }],
        role: Role.ASSISTANT,
        toolCalls: []
      })
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const manager = new LLMManager(registry);
    const provider = {
      id: 'test-sdk-provider',
      compat: 'test-compat',
      endpoint: { url: 'http://test.com' }
    } as any;

    const mockLogger = {
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    await manager.callProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      [],
      {},
      { extraField: 'extraValue' },
      mockLogger
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Extra field not supported by provider'),
      expect.objectContaining({
        provider: 'test-sdk-provider',
        field: 'extraField',
        value: '***'
      })
    );
  });
});

