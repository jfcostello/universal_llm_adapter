import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import * as toolDiscovery from '@/modules/tools/index.ts';

function createRegistryStub() {
  return {
    getMCPServers: jest.fn().mockReturnValue([]),
    getProcessRoutes: jest.fn().mockReturnValue([]),
    getProvider: jest.fn(),
    getVectorStores: jest.fn().mockReturnValue([])
  } as any;
}

describe('LLMCoordinator guard clauses', () => {
  function createResponse() {
    return {
      provider: 'stub-provider',
      model: 'stub-model',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
    } as any;
  }

  function createMockLogger() {
    const logger: any = {
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      withCorrelation: jest.fn()
    };
    logger.withCorrelation.mockReturnValue(logger);
    return logger;
  }

  test('run throws when llmPriority missing', async () => {
    const coordinator = new LLMCoordinator(createRegistryStub());
    await expect(coordinator.run({
      messages: [],
      settings: {},
      llmPriority: []
    } as any)).rejects.toThrow('LLMCallSpec.llmPriority must include at least one provider');
  });

  test('runStream throws when llmPriority missing', async () => {
    const coordinator = new LLMCoordinator(createRegistryStub());
    const iterator = coordinator.runStream({
      messages: [],
      settings: {},
      llmPriority: []
    } as any);

    await expect(iterator.next()).rejects.toThrow(
      'LLMCallSpec.llmPriority must include at least one provider'
    );
  });

  test('run returns provider response untouched when no tool calls detected', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const response = {
      provider: 'stub-provider',
      model: 'stub-model',
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
      finishReason: 'stop',
      usage: {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        reasoningTokens: 50
      }
    } as any;

    const callProvider = jest.fn().mockResolvedValue(response);
    (coordinator as any).llmManager = { callProvider };

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {}
    } as any;

    const result = await coordinator.run(spec);

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result).toEqual(response);
  });

  test('batch runtime setting resets logger only when value changes', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const initialLogger = (coordinator as any).logger;

    await (coordinator as any).applyRuntimeEnvironment({});

    await (coordinator as any).applyRuntimeEnvironment({ batchId: 'batch-one' });
    const afterFirst = (coordinator as any).logger;
    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('batch-one');
    expect(afterFirst).not.toBe(initialLogger);

    await (coordinator as any).applyRuntimeEnvironment({ batchId: 'batch-one' });
    expect((coordinator as any).logger).toBe(afterFirst);

    delete process.env.LLM_ADAPTER_BATCH_ID;
  });

  test('run throws when provider returns undefined response', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(undefined)
    };

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response: response was undefined');
  });

  test('run throws when provider response is missing assistant role', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'stub-provider',
        model: 'stub-model',
        role: 'user',
        content: []
      })
    };

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response: missing assistant role');
  });

  test('run throws when provider response content is not an array', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'stub-provider',
        model: 'stub-model',
        role: 'assistant',
        content: null
      })
    };

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response: content must be an array');
  });

  test('run handles provider identifier fallback when response omits provider field', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: undefined,
        model: 'stub-model',
        role: 'assistant',
        content: []
      })
    };

    const result = await coordinator.run(spec);
    expect(result.model).toBe('stub-model');
  });

  test('run injects vector context when mode is auto', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const mockInjector = {
      injectContext: jest.fn().mockResolvedValue({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Query' }] }],
        resultsInjected: 2,
        query: 'Query',
        retrievedResults: []
      })
    };
    (coordinator as any).vectorContextInjector = mockInjector;

    const spec = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Query' }] }],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      vectorContexts: [{
        stores: ['test-store'],
        mode: 'auto'
      }],
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'stub-provider',
        model: 'stub-model',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      })
    };

    await coordinator.run(spec);

    expect(mockInjector.injectContext).toHaveBeenCalledWith(
      expect.any(Array),
      spec.vectorContexts[0],
      undefined,
      expect.objectContaining({
        maxInjectedPayloadBytes: 16384,
        embeddingCache: expect.any(Map)
      })
    );
  });

  test('run applies auto-injection budget and skips remaining contexts after budget is exhausted', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);
    const logger = createMockLogger();
    (coordinator as any).logger = logger;

    const mockInjector = {
      injectContext: jest.fn().mockResolvedValue({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }] })
    };
    (coordinator as any).vectorContextInjector = mockInjector;
    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(createResponse())
    };

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)   // startedAt
      .mockReturnValueOnce(0)   // first context elapsed
      .mockReturnValueOnce(100); // second context elapsed -> budget exhausted

    await coordinator.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      vectorContexts: [
        { stores: ['memory-a'], mode: 'auto' },
        { stores: ['memory-b'], mode: 'auto' }
      ],
      vectorRequestPolicy: {
        totalAutoBudgetMs: 50,
        perContextTimeoutMs: 1000,
        maxAutoContexts: 5
      }
    } as any);

    expect(mockInjector.injectContext).toHaveBeenCalledTimes(1);
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector auto-injection budget exhausted; skipping remaining contexts',
      { totalAutoBudgetMs: 50 }
    );

    nowSpy.mockRestore();
  });

  test('run rethrows config_error from vector auto-injection', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const configError = Object.assign(new Error('invalid vector queryPriority config'), { code: 'config_error' });
    const mockInjector = {
      injectContext: jest.fn().mockRejectedValue(configError)
    };
    (coordinator as any).vectorContextInjector = mockInjector;
    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(createResponse())
    };

    await expect(
      coordinator.run({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }],
        llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        settings: {},
        vectorContexts: [{
          stores: ['memory'],
          mode: 'auto',
          locks: { collection: 'locked-collection' },
          queryPriority: [{ collection: 'candidate-collection', embeddingPriority: [{ provider: 'embeddings-a' }] }]
        }]
      } as any)
    ).rejects.toBe(configError);
  });

  test('run logs non-config vector auto-injection errors and continues', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);
    const logger = createMockLogger();
    (coordinator as any).logger = logger;

    const mockInjector = {
      injectContext: jest.fn().mockRejectedValue('boom-string')
    };
    (coordinator as any).vectorContextInjector = mockInjector;
    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(createResponse())
    };

    const result = await coordinator.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      vectorContexts: [{ stores: ['memory'], mode: 'auto' }]
    } as any);

    expect(result.role).toBe('assistant');
    expect(logger.warning).toHaveBeenCalledWith(
      'Vector context injection skipped due to error',
      expect.objectContaining({
        error: 'boom-string',
        mode: 'auto',
        stores: ['memory']
      })
    );
  });

  test('run updates tool coordinator with undefined tool vector contexts when alias maps exist', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const setVectorContexts = jest.fn();
    (coordinator as any).toolCoordinator = {
      setVectorContexts,
      routeAndInvoke: jest.fn(),
      close: jest.fn()
    };
    jest.spyOn(coordinator as any, 'ensureToolCoordinator').mockResolvedValue((coordinator as any).toolCoordinator);
    jest.spyOn(coordinator as any, 'collectTools').mockResolvedValue([
      [],
      [],
      {},
      { vector_search: { query: 'query' } }
    ]);

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(createResponse())
    };

    await coordinator.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      toolChoice: { type: 'single', name: 'ignored' },
      vectorContexts: [{ stores: ['memory'], mode: 'auto' }]
    } as any);

    expect(setVectorContexts).toHaveBeenCalledWith(
      undefined,
      registry,
      { vector_search: { query: 'query' } }
    );
  });

  test('run keeps both-mode vector contexts when alias maps are applied', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const setVectorContexts = jest.fn();
    (coordinator as any).toolCoordinator = {
      setVectorContexts,
      routeAndInvoke: jest.fn(),
      close: jest.fn()
    };
    jest.spyOn(coordinator as any, 'ensureToolCoordinator').mockResolvedValue((coordinator as any).toolCoordinator);
    jest.spyOn(coordinator as any, 'collectTools').mockResolvedValue([
      [],
      [],
      {},
      { semantic_search: { query: 'query' } }
    ]);

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(createResponse())
    };

    await coordinator.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      toolChoice: { type: 'single', name: 'ignored' },
      vectorContexts: [{ stores: ['memory'], mode: 'both', toolName: 'semantic_search' }]
    } as any);

    expect(setVectorContexts).toHaveBeenCalledWith(
      [{ stores: ['memory'], mode: 'both', toolName: 'semantic_search' }],
      registry,
      { semantic_search: { query: 'query' } }
    );
  });

  test('tool coordinator proxy stores pending vector contexts before initialization', () => {
    const coordinator = new LLMCoordinator(createRegistryStub());

    (coordinator as any).toolCoordinator.setVectorContexts(
      [{ stores: ['memory'], mode: 'tool' }],
      undefined,
      { vector_search: { q: 'query' } }
    );

    expect((coordinator as any).pendingVectorContexts).toEqual({
      configs: [{ stores: ['memory'], mode: 'tool' }],
      aliasMaps: { vector_search: { q: 'query' } }
    });
  });

  test('ensureToolCoordinator refresh uses undefined vector contexts when none are configured', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const firstSpec = {
      messages: [],
      settings: {},
      llmPriority: [{ provider: 'p', model: 'm' }],
      vectorContexts: [{ stores: ['memory'], mode: 'tool' }]
    } as any;

    const secondSpec = {
      ...firstSpec,
      vectorContexts: []
    } as any;

    await (coordinator as any).ensureToolCoordinator(firstSpec);
    const impl = (coordinator as any).toolCoordinatorImpl;
    const setSpy = jest.spyOn(impl, 'setVectorContexts');

    await (coordinator as any).ensureToolCoordinator(secondSpec);

    expect(setSpy).toHaveBeenCalledWith(undefined, registry);
  });

  test('ensureToolCoordinator refresh passes vector contexts when they are configured', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const firstSpec = {
      messages: [],
      settings: {},
      llmPriority: [{ provider: 'p', model: 'm' }],
      vectorContexts: []
    } as any;

    const secondSpec = {
      ...firstSpec,
      vectorContexts: [{ stores: ['memory'], mode: 'tool' }]
    } as any;

    await (coordinator as any).ensureToolCoordinator(firstSpec);
    const impl = (coordinator as any).toolCoordinatorImpl;
    const setSpy = jest.spyOn(impl, 'setVectorContexts');

    await (coordinator as any).ensureToolCoordinator(secondSpec);

    expect(setSpy).toHaveBeenCalledWith(
      [{ stores: ['memory'], mode: 'tool' }],
      registry
    );
  });
});
