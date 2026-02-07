import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { StreamEventType, Role, ToolCallEventType } from '@/kernel/index.ts';

const handleChunkMock = jest.fn();

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

function createCoordinator({ withDetector }: { withDetector: boolean }) {
    const compatModule = {
      parseStreamChunk: jest.fn().mockImplementation(chunk => ({
        text: 'token',
        toolEvents: withDetector ? handleChunkMock(chunk) : undefined
      }))
    };
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue(compatModule),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([]),
      getTool: jest.fn().mockImplementation((name: string) => ({
        name,
        description: 'function tool',
        parametersJsonSchema: { type: 'object' }
      }))
    } as any;

    const coordinator = new LLMCoordinator(registry);
    jest.spyOn(coordinator as any, 'collectTools').mockResolvedValue([
      [{ name: 'tool_sanitized', description: 'Tool', parametersJsonSchema: { type: 'object' } }],
      [],
      { tool_sanitized: 'tool.original' }
    ]);

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockImplementation(async function* () {
        yield { __events: [], chunk: 1 };
        if (withDetector) {
          yield {
            __events: [
              { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_sanitized' },
              { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{}' },
              { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_sanitized', arguments: '{}' }
            ]
          };
        }
      })
    };

    return { coordinator, compatModule };
}

describe('LLMCoordinator runStream', () => {
  afterEach(() => {
    handleChunkMock.mockReset();
  });

  test('yields tokens and done without detector', async () => {
    const { coordinator, compatModule } = createCoordinator({ withDetector: false });
    const events: any[] = [];

    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {}
    } as any)) {
      events.push(event);
    }

    // Events are now {type: "delta", content: "..."} and {type: "DONE", response: {...}}
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.type === 'delta' && e.content === 'token')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(handleChunkMock).not.toHaveBeenCalled();
    expect(compatModule.parseStreamChunk).toHaveBeenCalled();
  });

  test('does not initialize tool coordinator when toolChoice is null', async () => {
    const { coordinator } = createCoordinator({ withDetector: false });
    const registry = (coordinator as any).registry;

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {},
      toolChoice: null
    } as any)) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(registry.getProcessRoutes).not.toHaveBeenCalled();
    expect((coordinator as any).collectTools).not.toHaveBeenCalled();
  });

  test('initializes tool coordinator when toolChoice is an object', async () => {
    const { coordinator } = createCoordinator({ withDetector: false });
    const registry = (coordinator as any).registry;

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {},
      toolChoice: { type: 'single', name: 'tool_sanitized' }
    } as any)) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(registry.getProcessRoutes).toHaveBeenCalled();
    expect((coordinator as any).collectTools).toHaveBeenCalled();
  });

  test('emits tool events when detector present', async () => {
    const { coordinator } = createCoordinator({ withDetector: true });
    handleChunkMock.mockImplementation(chunk => chunk.__events || []);

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {}
    } as any)) {
      events.push(event);
    }

    // Events are now {type: "delta", content: "..."} and {type: "DONE", response: {...}}
    const deltaEvents = events.filter(e => e.type === 'delta' && e.content === 'token');
    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    const doneEvents = events.filter(e => e.type === 'done');

    expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEvents.length).toBe(3);
    expect(toolEvents[0].toolEvent).toMatchObject({ type: ToolCallEventType.TOOL_CALL_START });
    expect(toolEvents[1].toolEvent).toMatchObject({ type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA });
    expect(toolEvents[2].toolEvent).toMatchObject({ type: ToolCallEventType.TOOL_CALL_END });
    expect(doneEvents.length).toBe(1);
  });

  test('handles missing callId in TOOL_CALL_START (line 192)', async () => {
    const { coordinator } = createCoordinator({ withDetector: true });
    handleChunkMock.mockImplementation(chunk => chunk.__events || []);

    (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
      yield {
        __events: [
          // callId is undefined - tests line 192: event.callId?.toString() || ''
          { type: ToolCallEventType.TOOL_CALL_START, callId: undefined, name: 'tool_sanitized' },
          { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '0', argumentsDelta: '{}' },
          { type: ToolCallEventType.TOOL_CALL_END, callId: '0', name: 'tool_sanitized', arguments: '{}' }
        ]
      };
    });

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {}
    } as any)) {
      events.push(event);
    }

    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  test('handles missing callId in TOOL_CALL_ARGUMENTS_DELTA (line 200)', async () => {
    const { coordinator } = createCoordinator({ withDetector: true });
    handleChunkMock.mockImplementation(chunk => chunk.__events || []);

    (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
      yield {
        __events: [
          { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_sanitized' },
          // callId is undefined - tests line 200: event.callId?.toString() || '0'
          { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: undefined, argumentsDelta: '{}' },
          { type: ToolCallEventType.TOOL_CALL_END, callId: '0', name: 'tool_sanitized', arguments: '{}' }
        ]
      };
    });

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {}
    } as any)) {
      events.push(event);
    }

    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  test('handles missing argumentsDelta (line 204)', async () => {
    const { coordinator } = createCoordinator({ withDetector: true });
    handleChunkMock.mockImplementation(chunk => chunk.__events || []);

    (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
      yield {
        __events: [
          { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_sanitized' },
          // argumentsDelta is undefined - tests line 204: event.argumentsDelta || ''
          // Using matching callId '1' so state is found and line 204 executes
          { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: undefined },
          { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_sanitized', arguments: '{}' }
        ]
      };
    });

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {}
    } as any)) {
      events.push(event);
    }

    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  test('handles missing tool name using fallback chain (line 224)', async () => {
    const { coordinator, compatModule } = createCoordinator({ withDetector: true });
    handleChunkMock.mockImplementation(chunk => chunk.__events || []);

    // Override compat module to set finishedWithToolCalls
    compatModule.parseStreamChunk.mockImplementation(chunk => {
      if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
        return {
          text: undefined,
          toolEvents: chunk.__events,
          finishedWithToolCalls: true
        };
      }
      return {
        text: 'token',
        toolEvents: chunk.__events
      };
    });

    // Mock tool coordinator to avoid actual tool execution
    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ result: { test: 'result' } })
    };

    (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
      yield {
        __events: [
          // name is undefined - tests line 224: toolNameMap[state.name || ''] || state.name || 'unknown'
          // Using matching callId '1' so state is properly accumulated and line 224 executes
          { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: undefined },
          { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{}' },
          { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: undefined, arguments: '{}' }
        ],
        choices: [{ finish_reason: 'tool_calls' }]  // Trigger tool execution
      };
    });

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      functionToolNames: ['tool_sanitized'],  // Include function tools
      settings: {}
    } as any)) {
      events.push(event);
    }

    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  test('handles tool name not in toolNameMap (line 224 middle branch)', async () => {
    const { coordinator } = createCoordinator({ withDetector: true });
    handleChunkMock.mockImplementation(chunk => chunk.__events || []);

    // Mock tool coordinator to avoid actual tool execution
    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ result: { test: 'result' } })
    };

    (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
      yield {
        __events: [
          // name is 'unknown_tool' which won't be in toolNameMap
          // Tests: toolNameMap[state.name || ''] returns undefined, so falls back to state.name
          { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'not_in_map' },
          { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '0', argumentsDelta: '{}' },
          { type: ToolCallEventType.TOOL_CALL_END, callId: '0', name: 'not_in_map', arguments: '{}' }
        ],
        choices: [{ finish_reason: 'tool_calls' }]  // Trigger tool execution
      };
    });

    const events: any[] = [];
    for await (const event of coordinator.runStream({
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'provider', model: 'model' }],
      functionToolNames: ['tool_sanitized'],  // Include function tools
      settings: {}
    } as any)) {
      events.push(event);
    }

    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  describe('vector context injection', () => {
    function createCoordinatorWithVectorSupport() {
      const mockInjector = {
        injectContext: jest.fn().mockResolvedValue({
          messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Modified query' }] }],
          resultsInjected: 2,
          query: 'test query'
        })
      };

      const registry = {
        getProvider: jest.fn().mockReturnValue({ id: 'openrouter', compat: 'openai' }),
        getCompatModule: jest.fn().mockReturnValue({
          parseStreamChunk: jest.fn().mockReturnValue({ text: 'response' })
        }),
        getMCPServers: jest.fn().mockReturnValue([]),
        getProcessRoutes: jest.fn().mockReturnValue([]),
        getVectorStore: jest.fn().mockResolvedValue({ id: 'test-store', kind: 'memory' }),
        getVectorStoreCompat: jest.fn().mockResolvedValue({
          connect: jest.fn(),
          close: jest.fn(),
          query: jest.fn().mockResolvedValue([])
        }),
        getEmbeddingProvider: jest.fn().mockReturnValue({
          compat: { embed: jest.fn().mockResolvedValue({ vectors: [[0.1]], model: 'test', dimensions: 1 }) }
        })
      } as any;

      const coordinator = new LLMCoordinator(registry);

      // Mock the LLM manager
      (coordinator as any).llmManager = {
        streamProvider: jest.fn().mockImplementation(async function* () {
          yield { text: 'response' };
        }),
        callProvider: jest.fn().mockResolvedValue({
          text: 'LLM response',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
        })
      };

      return { coordinator, registry, mockInjector };
    }

    test('runStream injects vector context when mode is auto', async () => {
      const { coordinator, mockInjector } = createCoordinatorWithVectorSupport();

      // Inject the mock injector
      (coordinator as any).vectorContextInjector = mockInjector;

      const events: any[] = [];
      for await (const event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        vectorContexts: [{
          stores: ['test-store'],
          mode: 'auto'
        }]
      })) {
        events.push(event);
      }

      expect(mockInjector.injectContext).toHaveBeenCalled();
    });

    test('runStream applies auto-injection budget and skips remaining contexts', async () => {
      const { coordinator, mockInjector } = createCoordinatorWithVectorSupport();
      (coordinator as any).vectorContextInjector = mockInjector;
      const logger = createMockLogger();
      (coordinator as any).logger = logger;

      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(100);

      for await (const _event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        vectorContexts: [
          { stores: ['test-store-a'], mode: 'auto' },
          { stores: ['test-store-b'], mode: 'auto' }
        ],
        vectorRequestPolicy: {
          totalAutoBudgetMs: 50,
          perContextTimeoutMs: 1000,
          maxAutoContexts: 5
        }
      } as any)) {
        // consume
      }

      expect(mockInjector.injectContext).toHaveBeenCalledTimes(1);
      expect(logger.warning).toHaveBeenCalledWith(
        'Vector auto-injection budget exhausted; skipping remaining contexts',
        { totalAutoBudgetMs: 50 }
      );

      nowSpy.mockRestore();
    });

    test('runStream rethrows config_error from vector context injection', async () => {
      const { coordinator, mockInjector } = createCoordinatorWithVectorSupport();
      const configError = Object.assign(new Error('invalid vector config'), { code: 'config_error' });
      mockInjector.injectContext.mockRejectedValue(configError);
      (coordinator as any).vectorContextInjector = mockInjector;

      const iterator = coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        vectorContexts: [{ stores: ['test-store'], mode: 'auto' }]
      } as any);

      await expect(iterator.next()).rejects.toBe(configError);
    });

    test('runStream logs non-config vector injection errors and continues', async () => {
      const { coordinator, mockInjector } = createCoordinatorWithVectorSupport();
      const logger = createMockLogger();
      (coordinator as any).logger = logger;
      mockInjector.injectContext.mockRejectedValue('stream-boom');
      (coordinator as any).vectorContextInjector = mockInjector;

      const events: any[] = [];
      for await (const event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        vectorContexts: [{ stores: ['test-store'], mode: 'auto' }]
      } as any)) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'done')).toBe(true);
      expect(logger.warning).toHaveBeenCalledWith(
        'Vector context injection skipped due to error',
        expect.objectContaining({
          error: 'stream-boom',
          mode: 'auto',
          stores: ['test-store']
        })
      );
    });

    test('runStream injects vector context when mode is both', async () => {
      const { coordinator, mockInjector } = createCoordinatorWithVectorSupport();

      // Inject the mock injector
      (coordinator as any).vectorContextInjector = mockInjector;

      const events: any[] = [];
      for await (const event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        vectorContexts: [{
          stores: ['test-store'],
          mode: 'both'
        }]
      })) {
        events.push(event);
      }

      expect(mockInjector.injectContext).toHaveBeenCalled();
    });

    test('runStream does not inject when mode is tool', async () => {
      const { coordinator, mockInjector } = createCoordinatorWithVectorSupport();

      // Inject the mock injector
      (coordinator as any).vectorContextInjector = mockInjector;

      const events: any[] = [];
      for await (const event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        vectorContexts: [{
          stores: ['test-store'],
          mode: 'tool'
        }]
      })) {
        events.push(event);
      }

      expect(mockInjector.injectContext).not.toHaveBeenCalled();
    });

    test('runStream sets undefined tool vector contexts when alias maps are returned for auto-only configs', async () => {
      const { coordinator } = createCoordinatorWithVectorSupport();

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

      for await (const _event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'Query' }] }],
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {},
        toolChoice: { type: 'single', name: 'ignored' },
        vectorContexts: [{ stores: ['test-store'], mode: 'auto' }],
        vectorRequestPolicy: { maxAutoContexts: 0 }
      } as any)) {
        // consume
      }

      expect(setVectorContexts).toHaveBeenCalledWith(
        undefined,
        expect.any(Object),
        { vector_search: { query: 'query' } }
      );
    });

    test('runStream logs and caps pre-delta buffer before first delta', async () => {
      const { coordinator, compatModule } = createCoordinator({ withDetector: true });
      const logger = createMockLogger();
      (coordinator as any).logger = logger;

      let parseCount = 0;
      compatModule.parseStreamChunk.mockImplementation(() => {
        parseCount += 1;
        if (parseCount <= 300) {
          return {
            text: undefined,
            toolEvents: [{ type: ToolCallEventType.TOOL_CALL_START, callId: String(parseCount), name: 'tool_sanitized' }]
          };
        }
        return {
          text: 'token',
          toolEvents: []
        };
      });

      (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
        for (let i = 0; i < 301; i += 1) {
          yield { chunk: i };
        }
      });

      for await (const _event of coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'provider', model: 'model' }],
        settings: {}
      } as any)) {
        // consume
      }

      expect(logger.warning).toHaveBeenCalledWith(
        'Pre-delta stream buffer reached cap; dropping oldest events',
        { cap: 256 }
      );
    });

    test('runStream throws fallback error when attempts fail with undefined error before first delta', async () => {
      const { coordinator } = createCoordinator({ withDetector: false });
      (coordinator as any).llmManager.streamProvider = jest.fn().mockImplementation(async function* () {
        throw undefined;
      });

      const iterator = coordinator.runStream({
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'provider', model: 'model' }],
        settings: {}
      } as any);

      await expect(iterator.next()).rejects.toThrow('Streaming failed: all llmPriority attempts exhausted');
    });

    test('ensureVectorContextInjector lazily initializes injector', async () => {
      const { coordinator, registry } = createCoordinatorWithVectorSupport();

      // Initially no injector
      expect((coordinator as any).vectorContextInjector).toBeUndefined();

      // Call private method to ensure initialization
      const injector = await (coordinator as any).ensureVectorContextInjector();

      expect(injector).toBeDefined();
      expect((coordinator as any).vectorContextInjector).toBe(injector);
    });
  });
});
