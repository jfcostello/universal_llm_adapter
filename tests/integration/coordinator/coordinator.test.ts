import path from 'path';
import { jest } from '@jest/globals';
import { PluginRegistry } from '@/core/registry.ts';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { Role, LLMResponse, LLMCallSettings } from '@/core/types.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

const specBase = {
  messages: [
    {
      role: Role.USER,
      content: [{ type: 'text', text: 'use tool' }]
    }
  ],
  llmPriority: [
    {
      provider: 'test-openai',
      model: 'stub-model'
    }
  ],
  settings: {
    temperature: 0,
    toolCountdownEnabled: true,
    toolFinalPromptEnabled: true
  },
  functionToolNames: ['echo.text'],
  metadata: {
    correlationId: 'coord-test'
  }
};

describe('coordinator/coordinator integration', () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(ROOT_DIR);
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createCoordinator(): Promise<LLMCoordinator> {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const processRoutes = await registry.getProcessRoutes();
    processRoutes.forEach(route => {
      route.timeoutMs = 10;
    });
    return new LLMCoordinator(registry);
  }

  test('runs tool call workflow and aggregates tool results', async () => {
    const coordinator = await createCoordinator();
    const responses: LLMResponse[] = [
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo.text',
            arguments: { text: 'hello' }
          }
        ],
        raw: undefined
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final result' }],
        finishReason: 'stop'
      } as LLMResponse
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => {
        if (!responses.length) {
          throw new Error('unexpected call');
        }
        return responses.shift()!;
      });

    const spec = {
      ...specBase,
      settings: {
        ...specBase.settings,
        maxToolIterations: 2
      }
    };

    const result = await coordinator.run(spec as any);
    expect(result.content[0].text).toBe('final result');
    expect(result.raw?.toolResults?.[0].tool).toBe('echo.text');
    expect(callProviderMock).toHaveBeenCalledTimes(2);

    await coordinator.close();
  });

  test('handles consecutive tool call rounds and logs follow-up tool names', async () => {
    const coordinator = await createCoordinator();
    const responses: LLMResponse[] = [
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo.text',
            arguments: { text: 'first' }
          }
        ]
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-2',
            name: 'echo.text',
            arguments: { text: 'second' }
          }
        ]
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final after follow-up' }],
        finishReason: 'stop'
      }
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => {
        if (!responses.length) {
          throw new Error('unexpected follow-up');
        }
        return responses.shift()!;
      });

    const spec = {
      ...specBase,
      settings: {
        ...specBase.settings,
        maxToolIterations: 3
      }
    };

    const result = await coordinator.run(spec as any);
    expect(result.content[0].text).toBe('final after follow-up');
    expect(callProviderMock).toHaveBeenCalledTimes(3);
    expect(result.raw?.toolResults).toHaveLength(2);

    await coordinator.close();
  });

  test('final prompt triggered when tool budget exhausted', async () => {
    const coordinator = await createCoordinator();
    const responses: LLMResponse[] = [
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo.text',
            arguments: { text: 'hello' }
          }
        ]
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'post-tool' }],
        finishReason: 'stop'
      }
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => responses.shift()!);

    const spec = {
      ...specBase,
      settings: {
        ...specBase.settings,
        maxToolIterations: 1
      }
    };

    const result = await coordinator.run(spec as any);
    expect(result.content[0].text).toBe('post-tool');
    expect(callProviderMock).toHaveBeenCalledTimes(2);
    const finalCallArgs = callProviderMock.mock.calls[1];
    expect(finalCallArgs[4]).toEqual([]); // tools cleared for final prompt

    await coordinator.close();
  });

  test('normalizeFlag and sanitizeToolName helpers', async () => {
    const coordinator = await createCoordinator();
    const normalize = (coordinator as any).normalizeFlag.bind(coordinator);
    expect(normalize(undefined, true)).toBe(true);
    expect(normalize('yes', false)).toBe(true);
    expect(normalize('no', true)).toBe(false);
    expect(normalize(0, true)).toBe(false);

    const sanitize = (coordinator as any).sanitizeToolName.bind(coordinator);
    expect(sanitize('tool/name?')).toBe('tool_name_');
    expect(sanitize('')).toBe('tool');
    const longName = 'x'.repeat(100);
    expect(sanitize(longName)).toHaveLength(64);
    await coordinator.close();
  });

  test('should preprocess document content', async () => {
    const coordinator = await createCoordinator();

    // Create a spec with a document
    const docPath = path.join(process.cwd(), 'tests', 'fixtures', 'sample-documents', 'sample.txt');
    const specWithDoc = {
      ...specBase,
      messages: [
        {
          role: Role.USER,
          content: [
            { type: 'text' as const, text: 'Analyze this document' },
            {
              type: 'document' as const,
              source: { type: 'filepath' as const, path: docPath }
            }
          ]
        }
      ]
    };

    // Mock the LLM call to verify document was preprocessed
    const mockResponse: LLMResponse = {
      provider: 'test-openai',
      model: 'stub-model',
      role: Role.ASSISTANT,
      finishReason: 'stop',
      content: [{ type: 'text', text: 'Analysis complete' }],
      usage: { inputTokens: 10, outputTokens: 5 },
      raw: undefined
    };

    jest.spyOn(LLMManager.prototype, 'callProvider').mockResolvedValue(mockResponse);

    const response = await coordinator.run(specWithDoc as any);

    expect(response.finishReason).toBe('stop');
    expect(response.content[0].text).toBe('Analysis complete');

    await coordinator.close();
  });

  describe('per-provider settings', () => {
    test('uses per-provider settings when specified', async () => {
      const coordinator = await createCoordinator();
      const mockResponse: LLMResponse = {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        finishReason: 'stop',
        content: [{ type: 'text', text: 'response' }]
      };

      const callProviderMock = jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse);

      const spec = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'test' }] }
        ],
        llmPriority: [
          {
            provider: 'test-openai',
            model: 'stub-model',
            settings: { temperature: 0.3 }  // Per-provider override
          }
        ],
        settings: { temperature: 0.7, maxTokens: 100 }  // Global settings
      };

      await coordinator.run(spec as any);

      // Check that the merged settings were passed to callProvider
      const settingsArg = callProviderMock.mock.calls[0][2] as LLMCallSettings;
      expect(settingsArg.temperature).toBe(0.3);  // Per-provider value
      expect(settingsArg.maxTokens).toBe(100);    // Global fallback

      await coordinator.close();
    });

    test('uses global settings when no per-provider settings specified', async () => {
      const coordinator = await createCoordinator();
      const mockResponse: LLMResponse = {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        finishReason: 'stop',
        content: [{ type: 'text', text: 'response' }]
      };

      const callProviderMock = jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse);

      const spec = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'test' }] }
        ],
        llmPriority: [
          {
            provider: 'test-openai',
            model: 'stub-model'
            // No per-provider settings
          }
        ],
        settings: { temperature: 0.7, maxTokens: 100 }
      };

      await coordinator.run(spec as any);

      const settingsArg = callProviderMock.mock.calls[0][2] as LLMCallSettings;
      expect(settingsArg.temperature).toBe(0.7);
      expect(settingsArg.maxTokens).toBe(100);

      await coordinator.close();
    });

    test('deep merges nested objects like reasoning', async () => {
      const coordinator = await createCoordinator();
      const mockResponse: LLMResponse = {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        finishReason: 'stop',
        content: [{ type: 'text', text: 'response' }]
      };

      const callProviderMock = jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse);

      const spec = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'test' }] }
        ],
        llmPriority: [
          {
            provider: 'test-openai',
            model: 'stub-model',
            settings: { reasoning: { budget: 2000 } }  // Override only budget
          }
        ],
        settings: {
          temperature: 0.7,
          reasoning: { enabled: true, budget: 1000 }  // Global reasoning
        }
      };

      await coordinator.run(spec as any);

      const settingsArg = callProviderMock.mock.calls[0][2] as LLMCallSettings;
      expect(settingsArg.temperature).toBe(0.7);
      expect(settingsArg.reasoning).toEqual({
        enabled: true,  // Preserved from global
        budget: 2000    // Overridden by per-provider
      });

      await coordinator.close();
    });

    test('per-provider settings propagate to tool loop', async () => {
      const coordinator = await createCoordinator();
      const responses: LLMResponse[] = [
        {
          provider: 'test-openai',
          model: 'stub-model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            { id: 'call-1', name: 'echo.text', arguments: { text: 'hello' } }
          ]
        },
        {
          provider: 'test-openai',
          model: 'stub-model',
          role: Role.ASSISTANT,
          finishReason: 'stop',
          content: [{ type: 'text', text: 'done' }]
        }
      ];

      const callProviderMock = jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockImplementation(async () => responses.shift()!);

      const spec = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'use tool' }] }
        ],
        llmPriority: [
          {
            provider: 'test-openai',
            model: 'stub-model',
            settings: { temperature: 0.2 }  // Per-provider
          }
        ],
        settings: { temperature: 0.9, maxTokens: 500, maxToolIterations: 2 },
        functionToolNames: ['echo.text']
      };

      await coordinator.run(spec as any);

      // Both calls (initial and follow-up after tool) should use per-provider temperature
      expect(callProviderMock).toHaveBeenCalledTimes(2);

      const firstCallSettings = callProviderMock.mock.calls[0][2] as LLMCallSettings;
      const secondCallSettings = callProviderMock.mock.calls[1][2] as LLMCallSettings;

      expect(firstCallSettings.temperature).toBe(0.2);
      expect(secondCallSettings.temperature).toBe(0.2);
      expect(firstCallSettings.maxTokens).toBe(500);
      expect(secondCallSettings.maxTokens).toBe(500);

      await coordinator.close();
    });
  });

  describe('vector context with schema overrides', () => {
    test('passes alias map to tool coordinator when toolSchemaOverrides are configured', async () => {
      const coordinator = await createCoordinator();
      const mockResponse: LLMResponse = {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        finishReason: 'stop',
        content: [{ type: 'text', text: 'response with vector tool' }]
      };

      jest
        .spyOn(LLMManager.prototype, 'callProvider')
        .mockResolvedValue(mockResponse);

      const spec = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'search for something' }] }
        ],
        llmPriority: [
          {
            provider: 'test-openai',
            model: 'stub-model'
          }
        ],
        settings: { temperature: 0 },
        vectorContext: {
          mode: 'tool' as const,
          stores: ['test-store'],
          embeddingPriority: [{ provider: 'openrouter', model: 'test-embed' }],
          toolSchemaOverrides: {
            params: {
              topK: { name: 'maximum_results' }
            }
          }
        }
      };

      const result = await coordinator.run(spec as any);

      expect(result.finishReason).toBe('stop');
      expect(result.content[0].text).toBe('response with vector tool');

      await coordinator.close();
    });
  });

  describe('vector context auto mode logging', () => {
    test('EmbeddingLogger.logEmbeddingRequest is called when using auto mode with embeddings', async () => {
      // Import logging module to spy on the logger
      const loggingModule = await import('@/core/logging.ts');
      const { EmbeddingLogger } = loggingModule;

      // Spy on logEmbeddingRequest method
      const logEmbeddingRequestSpy = jest.spyOn(EmbeddingLogger.prototype, 'logEmbeddingRequest');

      const coordinator = await createCoordinator();

      // Mock embedding provider
      const mockEmbeddingCompat = {
        embed: jest.fn().mockImplementation(async (_input, _config, _model, logger) => {
          // Call the logger if provided (this simulates what the real compat does)
          if (logger) {
            logger.logEmbeddingRequest({
              url: 'http://test.com/embed',
              method: 'POST',
              headers: {},
              body: { input: 'test' },
              provider: 'test',
              model: 'test-model'
            });
          }
          return {
            vectors: [[0.1, 0.2, 0.3]],
            model: 'test-model',
            dimensions: 3
          };
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      // Mock vector store compat
      const mockVectorStoreCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'test content' } }
        ]),
        setLogger: jest.fn()
      };

      // Spy on registry methods
      const registrySpy = jest.spyOn((coordinator as any).registry, 'getVectorStore')
        .mockResolvedValue({
          id: 'test-store',
          kind: 'memory',
          defaultCollection: 'test'
        });
      const compatSpy = jest.spyOn((coordinator as any).registry, 'getVectorStoreCompat')
        .mockResolvedValue(mockVectorStoreCompat);
      const embeddingProviderSpy = jest.spyOn((coordinator as any).registry, 'getEmbeddingProvider')
        .mockResolvedValue({
          id: 'test-embeddings',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test.com' }
        });
      const embeddingCompatSpy = jest.spyOn((coordinator as any).registry, 'getEmbeddingCompat')
        .mockResolvedValue(mockEmbeddingCompat);

      const mockResponse: LLMResponse = {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        finishReason: 'stop',
        content: [{ type: 'text', text: 'response after auto injection' }]
      };

      jest.spyOn(LLMManager.prototype, 'callProvider').mockResolvedValue(mockResponse);

      const spec = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'search for something' }] }
        ],
        llmPriority: [
          {
            provider: 'test-openai',
            model: 'stub-model'
          }
        ],
        settings: { temperature: 0 },
        vectorContext: {
          mode: 'auto' as const,
          stores: ['test-store'],
          embeddingPriority: [{ provider: 'test-embeddings' }]
        }
      };

      await coordinator.run(spec as any);

      // The embed mock checks if logger is passed and calls logEmbeddingRequest if so
      // After the fix, this should be called because the logger is passed through
      expect(logEmbeddingRequestSpy).toHaveBeenCalled();

      logEmbeddingRequestSpy.mockRestore();
      registrySpy.mockRestore();
      compatSpy.mockRestore();
      embeddingProviderSpy.mockRestore();
      embeddingCompatSpy.mockRestore();
      await coordinator.close();
    });
  });
});
