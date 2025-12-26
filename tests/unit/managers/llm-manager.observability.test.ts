import fs from 'fs';
import path from 'path';
import { describe, expect, test, jest } from '@jest/globals';
import { LLMManager } from '@/modules/llm/index.ts';
import { ProviderExecutionError, Role } from '@/modules/kernel/index.ts';
import type { RunContext, Message } from '@/modules/kernel/index.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('LLMManager observability', () => {
  const mockMessages: Message[] = [
    { role: Role.USER, content: [{ type: 'text', text: 'test' }] }
  ];

  const mockProvider = {
    id: 'test-sdk-provider',
    compat: 'test-compat',
    endpoint: { url: 'http://test.com' }
  } as any;

  function createMockObservabilityContext(captureOverrides: Partial<Record<string, any>> = {}) {
    return {
      exporter: {
        recordLLMRequest: jest.fn().mockReturnValue({ eventId: 'req-1', queued: true }),
        recordLLMResponse: jest.fn().mockReturnValue({ eventId: 'resp-1', queued: true }),
        flush: jest.fn().mockResolvedValue(undefined)
      },
      traceId: 'trace-123',
      sessionId: 'session-456',
      metadata: { correlationId: 'corr-789' },
      // Default to "full capture" for these unit tests; production defaults are covered elsewhere.
      captureMessages: 'full',
      captureToolArgs: true,
      captureRequestPayload: true,
      captureRawResponse: true,
      sampleRate: 1,
      maxInputTextBytes: 4096,
      maxOutputTextBytes: 4096,
      maxJsonBytes: 8192,
      ...captureOverrides
    };
  }

  test('callProvider omits request/response payloads and tool args when capture flags are disabled', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: [{ id: 'tc-1', name: 'test_tool', arguments: { secret: 'abcd1234' } }],
      usage: { promptTokens: 10, completionTokens: 20 },
      raw: { token: 'abcd1234', ok: true }
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext({
      captureMessages: 'none',
      captureToolArgs: false,
      captureRequestPayload: false,
      captureRawResponse: false
    });
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      { api_key: 'sk-abcdef1234' },
      undefined,
      context
    );

    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
    expect(requestArg.messages).toEqual([]);
    expect(requestArg.requestPayload).toBeUndefined();

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.content).toEqual([]);
    expect(responseArg.rawResponse).toBeUndefined();
    expect(responseArg.toolCalls).toEqual([{ id: 'tc-1', name: 'test_tool' }]);
  });

  test('callProvider records LLM request when observability is enabled', async () => {
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

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      { api_key: 'sk-abcdef1234' },
      undefined,
      context
    );

    expect(observability.exporter.recordLLMRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        provider: 'test-sdk-provider',
        model: 'test-model',
        sessionId: 'session-456',
        metadata: { correlationId: 'corr-789' }
      })
    );

    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
    expect(typeof requestArg.generationId).toBe('string');
    expect(requestArg.requestPayload.providerExtras.api_key).toBe('***1234');
  });

  test('callProvider uses numeric timestampMs (and does not allocate ISO timestamps) for observability events', async () => {
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

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];

    expect(typeof requestArg.timestampMs).toBe('number');
    expect(requestArg.timestamp).toBeUndefined();

    expect(typeof responseArg.timestampMs).toBe('number');
    expect(responseArg.timestamp).toBeUndefined();
  });

  test('callProvider records LLM response on success', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: [{ id: 'tc-1', name: 'test_tool', arguments: { arg1: 'value1' } }],
      usage: { promptTokens: 10, completionTokens: 20 },
      raw: { token: 'abcd1234', ok: true }
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        provider: 'test-sdk-provider',
        model: 'test-model',
        content: [{ type: 'text', text: 'SDK response' }],
        rawResponse: { token: '***1234', ok: true },
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        toolCalls: [{ id: 'tc-1', name: 'test_tool', arguments: { arg1: 'value1' } }],
        durationMs: expect.any(Number),
        metadata: { correlationId: 'corr-789' }
      })
    );

    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(requestArg.generationId).toBe(responseArg.generationId);
  });

  test('records tool call args via args fallback and includes metadata when present', async () => {
    const registry = { getCompatModule: jest.fn() } as any;
    const manager = new LLMManager(registry);

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    await (manager as any).recordObservabilityResponse(
      context,
      'test-sdk-provider',
      'test-model',
      'gen-1',
      process.hrtime.bigint(),
      {
        content: [],
        role: Role.ASSISTANT,
        toolCalls: [
          { id: 'tc-1', name: 'tool-a', args: { arg1: 'value1' }, metadata: { token: 'abcd1234' } },
          { id: 'tc-2', name: 'tool-b' }
        ]
      },
      undefined,
      undefined,
      undefined
    );

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.toolCalls).toEqual([
      { id: 'tc-1', name: 'tool-a', arguments: { arg1: 'value1' }, metadata: { token: '***1234' } },
      { id: 'tc-2', name: 'tool-b' }
    ]);
  });

  test('recordObservabilityResponse falls back to context.toolCallsSoFar when response has no toolCalls', async () => {
    const registry = { getCompatModule: jest.fn() } as any;
    const manager = new LLMManager(registry);

    const observability = createMockObservabilityContext({ captureToolArgs: false });
    const context: RunContext = {
      observability,
      toolCallsSoFar: [{ id: 'tc-ctx-1', name: 'tool-from-context', arguments: { secret: 'abcd1234' } }]
    };

    await (manager as any).recordObservabilityResponse(
      context,
      'test-sdk-provider',
      'test-model',
      'gen-1',
      process.hrtime.bigint(),
      {
        content: [],
        role: Role.ASSISTANT,
        toolCalls: []
      },
      undefined,
      undefined,
      undefined
    );

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.toolCalls).toEqual([{ id: 'tc-ctx-1', name: 'tool-from-context' }]);
  });

  test('callProvider computes totalTokens when promptTokens/completionTokens are zero', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 }
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
      })
    );
  });

  test('when LLM_LIVE=1, callProvider writes observability events to the live log across SDK + HTTP success/error paths', async () => {
    const prevLive = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';
    try {
      await withTempCwd('llm-manager-observability-live-log', async () => {
        const observability = createMockObservabilityContext();
        const context: RunContext = {
          observability,
          metadata: { testFile: 'llm-manager-observability-live-log', testName: 'unit', correlationId: 'corr-789' }
        } as any;

        // SDK path: success to cover request/response live-log branches.
        const sdkSuccessCompat = {
          callSDK: jest.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'SDK response' }],
            role: Role.ASSISTANT,
            toolCalls: []
          })
        };
        const sdkSuccessRegistry = { getCompatModule: jest.fn().mockReturnValue(sdkSuccessCompat) } as any;
        const sdkSuccessManager = new LLMManager(sdkSuccessRegistry);
        await sdkSuccessManager.callProvider(
          mockProvider,
          'test-model',
          { temperature: 0.7 },
          mockMessages,
          [],
          undefined,
          {},
          undefined,
          context
        );

        // SDK path: fail to cover error observability + live log.
        const sdkCompat = { callSDK: jest.fn().mockRejectedValue(new Error('SDK failed')) };
        const sdkRegistry = { getCompatModule: jest.fn().mockReturnValue(sdkCompat) } as any;
        const sdkManager = new LLMManager(sdkRegistry);
        await expect(
          sdkManager.callProvider(
            mockProvider,
            'test-model',
            { temperature: 0.7 },
            mockMessages,
            [],
            undefined,
            {},
            undefined,
            context
          )
        ).rejects.toThrow(ProviderExecutionError);

        // HTTP path: success + status error + transport error to cover all live-log branches.
        const httpProvider = {
          id: 'test-http-provider',
          compat: 'test-http-compat',
          endpoint: {
            urlTemplate: 'http://service/{model}',
            method: 'POST',
            headers: {}
          },
          retryWords: []
        } as any;

        const httpCompat = {
          buildPayload: jest.fn(() => ({ metadata: {} })),
          parseResponse: jest.fn(() => ({
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'HTTP response' }],
            toolCalls: []
          }))
        };
        const httpRegistry = { getCompatModule: jest.fn().mockReturnValue(httpCompat) } as any;
        const httpManager = new LLMManager(httpRegistry);

        (httpManager as any).httpClient = {
          request: jest.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: { ok: true } })
        };
        await httpManager.callProvider(
          httpProvider,
          'test-model',
          {},
          mockMessages,
          [],
          undefined,
          {},
          undefined,
          context
        );

        (httpManager as any).httpClient = {
          request: jest.fn().mockResolvedValue({ status: 400, statusText: 'Bad', headers: {}, data: { error: 'bad' } })
        };
        await expect(
          httpManager.callProvider(
            httpProvider,
            'test-model',
            {},
            mockMessages,
            [],
            undefined,
            {},
            undefined,
            context
          )
        ).rejects.toThrow(ProviderExecutionError);

        (httpManager as any).httpClient = {
          request: jest.fn().mockRejectedValue(new Error('network boom'))
        };
        await expect(
          httpManager.callProvider(
            httpProvider,
            'test-model',
            {},
            mockMessages,
            [],
            undefined,
            {},
            undefined,
            context
          )
        ).rejects.toThrow(ProviderExecutionError);

        const dateOnly = new Date().toISOString().split('T')[0];
        const logFile = path.join(process.cwd(), 'tests', 'live', 'logs', `${dateOnly}-llm-manager-observability-live-log.log`);
        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('>>> OBSERVABILITY EVENT >>>');
        expect(content).toContain('Event Type: LLM_REQUEST');
        expect(content).toContain('Event Type: LLM_RESPONSE');
      });
    } finally {
      process.env.LLM_LIVE = prevLive;
    }
  });

  test('callProvider records error response on SDK failure', async () => {
    const mockCompat = {
      callSDK: jest.fn().mockRejectedValue(new Error('SDK failed'))
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);

    await expect(
      manager.callProvider(
        mockProvider,
        'test-model',
        { temperature: 0.7 },
        mockMessages,
        [],
        undefined,
        {},
        undefined,
        context
      )
    ).rejects.toThrow(ProviderExecutionError);

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        provider: 'test-sdk-provider',
        model: 'test-model',
        error: { message: 'SDK failed', retryable: false },
        durationMs: expect.any(Number)
      })
    );
  });

  test('callProvider records rate limit error with retryable flag', async () => {
    const rateLimitError = new ProviderExecutionError('test-sdk-provider', 'Rate limited', 429, true);
    const mockCompat = {
      callSDK: jest.fn().mockRejectedValue(rateLimitError)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);

    await expect(
      manager.callProvider(
        mockProvider,
        'test-model',
        { temperature: 0.7 },
        mockMessages,
        [],
        undefined,
        {},
        undefined,
        context
      )
    ).rejects.toThrow(ProviderExecutionError);

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ retryable: true })
      })
    );
  });

  test('callProvider does not record observability when context has no observability', async () => {
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

    const context: RunContext = {};

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    // Should complete without error, no observability calls made
    expect(mockCompat.callSDK).toHaveBeenCalled();
  });

  test('callProvider handles observability request recording error gracefully', async () => {
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

    const observability = {
      exporter: {
        recordLLMRequest: jest.fn().mockImplementation(() => {
          throw new Error('Observability failed');
        }),
        recordLLMResponse: jest.fn().mockReturnValue({ eventId: 'resp-1', queued: true }),
        flush: jest.fn().mockResolvedValue(undefined)
      },
      traceId: 'trace-123'
    };

    const mockLogger = {
      warning: jest.fn(),
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    const result = await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      mockLogger,
      context
    );

    // Should complete successfully despite observability error
    expect(result.content).toEqual([{ type: 'text', text: 'SDK response' }]);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to record observability request event',
      expect.objectContaining({ error: 'Observability failed' })
    );
  });

  test('callProvider handles observability response recording error gracefully', async () => {
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

    const observability = {
      exporter: {
        recordLLMRequest: jest.fn().mockReturnValue({ eventId: 'req-1', queued: true }),
        recordLLMResponse: jest.fn().mockImplementation(() => {
          throw new Error('Response recording failed');
        }),
        flush: jest.fn().mockResolvedValue(undefined)
      },
      traceId: 'trace-123'
    };

    const mockLogger = {
      warning: jest.fn(),
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    const result = await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      mockLogger,
      context
    );

    // Should complete successfully despite observability error
    expect(result.content).toEqual([{ type: 'text', text: 'SDK response' }]);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to record observability response event',
      expect.objectContaining({ error: 'Response recording failed' })
    );
  });

  test('callProvider records response with null usage tokens as undefined', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: [],
      usage: { promptTokens: null, completionTokens: null }
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({
          promptTokens: undefined,
          completionTokens: undefined,
          totalTokens: undefined
        })
      })
    );
  });

  test('callProvider records response usage details when provided (totalTokens and extras)', async () => {
    const mockSDKResponse = {
      content: [{ type: 'text', text: 'SDK response' }],
      role: Role.ASSISTANT,
      toolCalls: [],
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 999,
        cachedTokens: 5,
        reasoningTokens: 2,
        audioTokens: 0,
        cost: 0.01
      }
    };

    const mockCompat = {
      callSDK: jest.fn().mockResolvedValue(mockSDKResponse)
    };

    const registry = {
      getCompatModule: jest.fn().mockReturnValue(mockCompat)
    } as any;

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 999,
          cachedTokens: 5,
          reasoningTokens: 2,
          audioTokens: 0,
          cost: 0.01
        })
      })
    );
  });

  test('callProvider records response without usage when not provided', async () => {
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

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      [],
      undefined,
      {},
      undefined,
      context
    );

    const call = (observability.exporter.recordLLMResponse as jest.Mock).mock.calls[0][0];
    expect(call.usage).toBeUndefined();
  });

  test('callProvider records tools in request event', async () => {
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

    const observability = createMockObservabilityContext();
    const context: RunContext = { observability };
    const tools = [
      { name: 'test_tool', description: 'A test tool', parameters: {} },
      { name: 'another_tool', description: 'Another tool', parameters: {} }
    ] as any[];

    const manager = new LLMManager(registry);
    await manager.callProvider(
      mockProvider,
      'test-model',
      { temperature: 0.7 },
      mockMessages,
      tools,
      undefined,
      {},
      undefined,
      context
    );

    expect(observability.exporter.recordLLMRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          { name: 'test_tool', description: 'A test tool' },
          { name: 'another_tool', description: 'Another tool' }
        ]
      })
    );
  });
});
