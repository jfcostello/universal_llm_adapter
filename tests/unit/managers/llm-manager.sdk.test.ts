import { describe, expect, test, jest } from '@jest/globals';
import { LLMManager } from '@/managers/llm-manager.ts';
import { ProviderExecutionError } from '@/core/errors.ts';
import { Role } from '@/core/types.ts';

describe('LLMManager SDK paths', () => {
  test('callProvider uses SDK when compat has callSDK method', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: []
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
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

    const result = await manager.callProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      []
    );

    expect(mockCompat.callSDK).toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: 'SDK response' }]);
    expect(result.provider).toBe('test-sdk-provider');
  });

  test('callProvider handles SDK errors and wraps in ProviderExecutionError', async () => {
    const mockCompat = {
      callSDK: jest.fn().mockRejectedValue(new Error('SDK failed'))
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

    await expect(
      manager.callProvider(
        provider,
        'test-model',
        { temperature: 0.7 },
        [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
        []
      )
    ).rejects.toThrow(ProviderExecutionError);
  });

  test('callProvider does not wrap ProviderExecutionError from SDK', async () => {
    const originalError = new ProviderExecutionError('test-provider', 'Original error');
    const mockCompat = {
      callSDK: jest.fn().mockRejectedValue(originalError)
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

    await expect(
      manager.callProvider(
        provider,
        'test-model',
        { temperature: 0.7 },
        [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
        []
      )
    ).rejects.toBe(originalError);
  });

  test('streamProvider uses SDK when compat has streamSDK method', async () => {
    async function* mockStreamGenerator() {
      yield { type: 'content_start' };
      yield { type: 'text_delta', text: 'chunk1' };
      yield { type: 'text_delta', text: 'chunk2' };
    }

    const mockCompat = {
      streamSDK: jest.fn().mockReturnValue(mockStreamGenerator())
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

    const chunks: any[] = [];
    for await (const chunk of manager.streamProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      []
    )) {
      chunks.push(chunk);
    }

    expect(mockCompat.streamSDK).toHaveBeenCalled();
    expect(chunks).toHaveLength(3);
    expect(chunks[1].text).toBe('chunk1');
  });

  test('streamProvider handles SDK streaming errors', async () => {
    async function* mockFailingStreamGenerator() {
      yield { type: 'content_start' };
      throw new Error('Stream failed');
    }

    const mockCompat = {
      streamSDK: jest.fn().mockReturnValue(mockFailingStreamGenerator())
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

    const iterator = manager.streamProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      []
    );

    await expect(async () => {
      for await (const _chunk of iterator) {
        // iterate until error
      }
    }).rejects.toThrow(ProviderExecutionError);
  });

  test('callProvider logs SDK usage and provider extras with logger', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: []
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const mockLogger = {
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const manager = new LLMManager(registry);
    const provider = {
      id: 'test-sdk-provider',
      compat: 'test-compat',
      endpoint: { url: 'http://test.com' }
    } as any;

    await manager.callProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      [],
      {},
      { customField: 'customValue' },
      mockLogger
    );

    // Verify logger was called
    expect(mockLogger.info).toHaveBeenCalledWith('Using SDK-based compat', { provider: 'test-sdk-provider', model: 'test-model' });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Extra field not supported by provider'),
      expect.objectContaining({
        provider: 'test-sdk-provider',
        field: 'customField',
        value: 'customValue'
      })
    );
    expect(mockLogger.logLLMRequest).toHaveBeenCalled();
    expect(mockLogger.logLLMResponse).toHaveBeenCalled();
  });

  test('callProvider logs to console.error when LLM_LIVE=1 and provider extras exist', async () => {
    const originalEnv = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: []
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const mockLogger = {
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const manager = new LLMManager(registry);
    const provider = {
      id: 'test-sdk-provider',
      compat: 'test-compat',
      endpoint: { url: 'http://test.com' }
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

    // Verify console.error was called for live test logging
    expect(consoleErrorSpy).toHaveBeenCalled();
    const calls = consoleErrorSpy.mock.calls;
    const hasExpectedLog = calls.some(call => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.level === 'info' && parsed.data?.field === 'extraField';
      } catch {
        return false;
      }
    });
    expect(hasExpectedLog).toBe(true);

    consoleErrorSpy.mockRestore();
    process.env.LLM_LIVE = originalEnv;
  });

  test('streamProvider logs SDK streaming with logger', async () => {
    async function* mockStreamGenerator() {
      yield { type: 'content_start' };
      yield { type: 'text_delta', text: 'chunk1' };
    }

    const mockCompat = {
      streamSDK: jest.fn().mockReturnValue(mockStreamGenerator())
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const mockLogger = {
      info: jest.fn()
    } as any;

    const manager = new LLMManager(registry);
    const provider = {
      id: 'test-sdk-provider',
      compat: 'test-compat',
      endpoint: { url: 'http://test.com' }
    } as any;

    const chunks: any[] = [];
    for await (const chunk of manager.streamProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      [],
      {},
      {},
      mockLogger
    )) {
      chunks.push(chunk);
    }

    // Verify logger was called for SDK streaming
    expect(mockLogger.info).toHaveBeenCalledWith('Using SDK-based streaming compat', { provider: 'test-sdk-provider', model: 'test-model' });
    expect(chunks).toHaveLength(2);
  });

  test('streamProvider collects chunks when LLM_LIVE=1', async () => {
    const originalEnv = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';

    async function* mockStreamGenerator() {
      yield { type: 'content_start' };
      yield { type: 'text_delta', text: 'chunk1' };
      yield { type: 'text_delta', text: 'chunk2' };
    }

    const mockCompat = {
      streamSDK: jest.fn().mockReturnValue(mockStreamGenerator())
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

    const chunks: any[] = [];
    for await (const chunk of manager.streamProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      []
    )) {
      chunks.push(chunk);
    }

    // Verify chunks were collected (live test logging path)
    expect(chunks).toHaveLength(3);

    process.env.LLM_LIVE = originalEnv;
  });

  test('streamProvider does not wrap ProviderExecutionError from SDK streaming', async () => {
    async function* mockFailingStreamGenerator() {
      throw new ProviderExecutionError('test-provider', 'Original SDK streaming error');
    }

    const mockCompat = {
      streamSDK: jest.fn().mockReturnValue(mockFailingStreamGenerator())
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

    const iterator = manager.streamProvider(
      provider,
      'test-model',
      { temperature: 0.7 },
      [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
      []
    );

    let caughtError;
    try {
      for await (const _chunk of iterator) {
        // iterate until error
      }
    } catch (error) {
      caughtError = error;
    }

    // Verify the original ProviderExecutionError is thrown, not wrapped
    expect(caughtError).toBeInstanceOf(ProviderExecutionError);
    expect((caughtError as ProviderExecutionError).message).toBe('[test-provider] Original SDK streaming error');
  });
});
