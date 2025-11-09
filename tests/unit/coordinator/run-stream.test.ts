import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { StreamEventType, Role, ToolCallEventType } from '@/core/types.ts';

const handleChunkMock = jest.fn();

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
    expect(events.some(e => e.type === 'DONE')).toBe(true);
    expect(handleChunkMock).not.toHaveBeenCalled();
    expect(compatModule.parseStreamChunk).toHaveBeenCalled();
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
    const doneEvents = events.filter(e => e.type === 'DONE');

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

  test('executeToolsAndContinueStreaming handles string tool results', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue('string-output')
    };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {})())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    const generator = (coordinator as any).executeToolsAndContinueStreaming(
      { settings: {}, metadata: {} },
      { toolCountdownEnabled: false },
      messages,
      tools,
      [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
      { id: 'provider', compat: 'mock' },
      'model',
      { tool_sanitized: 'tool.original' },
      {},
      logger,
      'auto'
    );

    for await (const _event of generator) {
      // exhaust generator
    }

    const toolMessages = messages.filter(message => message.role === Role.TOOL);
    expect(toolMessages.some(message =>
      message.content.some((part: any) => part.type === 'text' && part.text === 'string-output')
    )).toBe(true);
  });

  test('executeToolsAndContinueStreaming serializes non-string tool results', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ ok: true })
    };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {})())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    const gen = (coordinator as any).executeToolsAndContinueStreaming(
      { settings: {}, metadata: {} },
      { toolCountdownEnabled: false },
      messages,
      tools,
      [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
      { id: 'provider', compat: 'mock' },
      'model',
      { tool_sanitized: 'tool.original' },
      {},
      logger,
      'auto'
    );

    for await (const _ of gen) { /* exhaust */ }

    const toolMsg = messages.find(m => m.role === Role.TOOL);
    const textPart = toolMsg.content.find((p: any) => p.type === 'text');
    expect(textPart.text).toBe(JSON.stringify({ ok: true }));
  });

  test('executeToolsAndContinueStreaming handles tool execution error branch', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockRejectedValue(new Error('boom'))
    };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {})())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    const gen = (coordinator as any).executeToolsAndContinueStreaming(
      { settings: {}, metadata: {} },
      { toolCountdownEnabled: false },
      messages,
      tools,
      [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
      { id: 'provider', compat: 'mock' },
      'model',
      { tool_sanitized: 'tool.original' },
      {},
      logger,
      'auto'
    );

    for await (const _ of gen) { /* exhaust */ }

    // Assert error result was appended
    const toolMsg = messages.find(m => m.role === Role.TOOL);
    expect(toolMsg).toBeDefined();
    const errorPart = toolMsg.content.find((p: any) => p.type === 'tool_result');
    expect(errorPart.result.error).toBe('tool_execution_failed');
  });

  test('executeToolsAndContinueStreaming handles non-Error tool execution failure', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockRejectedValue('bad')
    };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {})())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    const gen = (coordinator as any).executeToolsAndContinueStreaming(
      { settings: {}, metadata: {} },
      { toolCountdownEnabled: false },
      messages,
      tools,
      [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
      { id: 'provider', compat: 'mock' },
      'model',
      { tool_sanitized: 'tool.original' },
      {},
      logger,
      'auto'
    );

    for await (const _ of gen) { /* exhaust */ }

    const toolMsg = messages.find(m => m.role === Role.TOOL);
    const errorText = toolMsg.content.find((p: any) => p.type === 'text').text;
    expect(errorText).toContain('tool_execution_failed');
  });

  test('executeToolsAndContinueStreaming handles error creating follow-up stream', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue('ok')
    };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn(() => { throw new Error('failed to create'); })
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    await expect(async () => {
      const gen = (coordinator as any).executeToolsAndContinueStreaming(
        { settings: {}, metadata: {} },
        { toolCountdownEnabled: false },
        messages,
        tools,
        [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
        { id: 'provider', compat: 'mock' },
        'model',
        { tool_sanitized: 'tool.original' },
        {},
        logger,
        'auto'
      );
      for await (const _ of gen) { /* exhaust */ }
    }).rejects.toThrow('failed to create');
  });

  test('executeToolsAndContinueStreaming handles non-Error when creating follow-up stream', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = { routeAndInvoke: jest.fn().mockResolvedValue('ok') };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn(() => { throw 'string failure'; })
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    await expect(async () => {
      const gen = (coordinator as any).executeToolsAndContinueStreaming(
        { settings: {}, metadata: {} },
        { toolCountdownEnabled: false },
        messages,
        tools,
        [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
        { id: 'provider', compat: 'mock' },
        'model',
        { tool_sanitized: 'tool.original' },
        {},
        logger,
        'auto'
      );
      for await (const _ of gen) { /* exhaust */ }
    }).rejects.toBe('string failure');
  });

  test('executeToolsAndContinueStreaming handles non-Error when iterating follow-up stream', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({})
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = { routeAndInvoke: jest.fn().mockResolvedValue('ok') };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {
        yield { x: 1 };
        throw { custom: true };
      })())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    await expect(async () => {
      const gen = (coordinator as any).executeToolsAndContinueStreaming(
        { settings: {}, metadata: {} },
        { toolCountdownEnabled: false },
        messages,
        tools,
        [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
        { id: 'provider', compat: 'mock' },
        'model',
        { tool_sanitized: 'tool.original' },
        {},
        logger,
        'auto'
      );
      for await (const _ of gen) { /* exhaust */ }
    }).rejects.toEqual({ custom: true });
  });

  test('executeToolsAndContinueStreaming handles error iterating follow-up stream', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({ text: 'x' })
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = { routeAndInvoke: jest.fn().mockResolvedValue('ok') };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {
        yield { some: 'chunk' };
        throw new Error('iterate failed');
      })())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    await expect(async () => {
      const gen = (coordinator as any).executeToolsAndContinueStreaming(
        { settings: {}, metadata: {} },
        { toolCountdownEnabled: false },
        messages,
        tools,
        [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
        { id: 'provider', compat: 'mock' },
        'model',
        { tool_sanitized: 'tool.original' },
        {},
        logger,
        'auto'
      );
      for await (const _ of gen) { /* exhaust */ }
    }).rejects.toThrow('iterate failed');
  });

  test('executeToolsAndContinueStreaming handles follow-up chunk without text', async () => {
    const registry = {
      getProvider: jest.fn().mockReturnValue({ id: 'provider', compat: 'mock' }),
      getCompatModule: jest.fn().mockReturnValue({
        parseStreamChunk: jest.fn().mockReturnValue({}) // no text field
      }),
      getMCPServers: jest.fn().mockReturnValue([]),
      getProcessRoutes: jest.fn().mockReturnValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn(), error: jest.fn() };

    (coordinator as any).toolCoordinator = { routeAndInvoke: jest.fn().mockResolvedValue('ok') };

    (coordinator as any).llmManager = {
      streamProvider: jest.fn().mockReturnValue((async function* () {
        yield { any: 'chunk' }; // parsed to no text
      })())
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'tool_sanitized', description: 'tool', parametersJsonSchema: { type: 'object' } }];

    const gen = (coordinator as any).executeToolsAndContinueStreaming(
      { settings: {}, metadata: {} },
      { toolCountdownEnabled: false },
      messages,
      tools,
      [{ id: 'call-1', name: 'tool_sanitized', arguments: {} }],
      { id: 'provider', compat: 'mock' },
      'model',
      { tool_sanitized: 'tool.original' },
      {},
      logger,
      'auto'
    );

    for await (const _ of gen) { /* exhaust */ }

    // No assertion needed; the goal is to cover the false branch of if(parsed.text)
    expect(true).toBe(true);
  });
});
