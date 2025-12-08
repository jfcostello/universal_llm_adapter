import { jest } from '@jest/globals';
import { StreamCoordinator } from '@/coordinator/stream-coordinator.ts';
import { StreamEventType, ToolCallEventType, Role } from '@/core/types.ts';

function createCoordinator(overrides: Partial<any> = {}) {
  const compatModule = {
    parseStreamChunk: jest.fn((chunk: any) => ({
      text: chunk.choices?.[0]?.delta?.content,
      toolEvents: undefined
    })),
    ...overrides.compatModule
  };

  const registry = {
    getProvider: jest.fn(() => ({ id: 'provider', compat: 'openai' })),
    getCompatModule: jest.fn(() => compatModule),
    ...overrides.registry
  };

  const llmManager = {
    streamProvider: jest.fn(),
    ...overrides.llmManager
  };

  const toolCoordinator = {
    routeAndInvoke: jest.fn(),
    close: jest.fn(),
    ...overrides.toolCoordinator
  };

  return {
    coordinator: new StreamCoordinator(registry, llmManager, toolCoordinator),
    registry,
    llmManager,
    toolCoordinator,
    compatModule
  };
}

function createContext() {
  return {
    provider: 'provider',
    model: 'model',
    tools: [],
    mcpServers: [],
    toolNameMap: new Map<string, string>(),
    logger: { info: jest.fn() }
  };
}

describe('StreamCoordinator', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('coordinateStream yields tokens and completion without detector', async () => {
    const { coordinator, llmManager } = createCoordinator({
      llmManager: {
        streamProvider: jest.fn(async function* () {
          yield { choices: [{ delta: { content: 'hello' } }] };
        })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {}
    };

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [], createContext())) {
      events.push(event);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(1);
    // Stream now emits {type: "delta", content: "..."} and {type: "DONE", response: {...}}
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'delta', content: 'hello' });
    expect(events[1].type).toBe('done');
    expect(events[1].response).toBeDefined();
  });

  test('coordinateStream dispatches tool events and follow-up streaming', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{ delta: { content: 'token-1' } }] };
      })(),
      (async function* () {
        yield { choices: [{ delta: { content: 'follow-up' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, registry, llmManager, toolCoordinator, compatModule } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          // First chunk returns tool events
          if (parseCallCount === 1) {
            return {
              text: chunk.choices?.[0]?.delta?.content,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool.sanitized' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{"a":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool.sanitized', arguments: '{"a":1}' }
              ]
            };
          }
          // Follow-up chunks return just text
          return {
            text: chunk.choices?.[0]?.delta?.content,
            toolEvents: undefined
          };
        })
      },
      llmManager: {
        streamProvider: jest.fn(() => streamResponses.shift()!)
      },
      toolCoordinator: {
        routeAndInvoke: jest.fn().mockResolvedValue({ ok: true })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 2, toolCountdownEnabled: true },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['tool.sanitized', 'tool.original']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool.original' }], context)) {
      events.push(event);
    }

    expect(compatModule.parseStreamChunk).toHaveBeenCalled();
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.original',
      '1',
      { a: 1 },
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.original',
      '1',
      { a: 1 },
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
    // Stream now emits {type: "delta", content: "..."}, {type: "tool_call", toolCall: {...}}, and {type: "DONE", response: {...}}
    const deltaEvents = events.filter(e => e.type === 'delta');
    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    const doneEvents = events.filter(e => e.type === 'done');

    expect(deltaEvents.length).toBeGreaterThanOrEqual(2);
    expect(deltaEvents[0].content).toBe('token-1');
    expect(deltaEvents.some(e => e.content === 'follow-up')).toBe(true);

    expect(toolEvents.length).toBeGreaterThanOrEqual(4); // START, DELTA, END, RESULT
    expect(toolEvents.some(e => e.toolEvent?.type === ToolCallEventType.TOOL_CALL_START)).toBe(true);
    expect(toolEvents.some(e => e.toolEvent?.type === ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA)).toBe(true);
    expect(toolEvents.some(e => e.toolEvent?.type === ToolCallEventType.TOOL_CALL_END)).toBe(true);
    expect(toolEvents.some(e => e.toolEvent?.type === ToolCallEventType.TOOL_RESULT && e.toolEvent?.callId === '1')).toBe(true);

    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].response).toBeDefined();
  });

  test('coordinateStream handles exhausted tool budget in streaming follow-up', async () => {
    const followUpStream = (async function* () {
      yield { text: 'summary' };
    })();

    let parseCallCount = 0;
    const { coordinator, llmManager, toolCoordinator } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          // First chunk returns tool events
          if (parseCallCount === 1) {
            return {
              text: chunk.choices?.[0]?.delta?.content,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'limited.tool' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'limited.tool', arguments: '{}' }
              ]
            };
          }
          // Follow-up chunk
          return {
            text: chunk.text,
            toolEvents: undefined
          };
        })
      },
      llmManager: {
        streamProvider: jest.fn()
          .mockReturnValueOnce((async function* () {
            yield { choices: [{ delta: { content: 'partial' } }] };
          })())
          .mockReturnValueOnce(followUpStream)
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 0, toolCountdownEnabled: false },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['limited.tool', 'limited.tool']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'limited.tool' }], context)) {
      events.push(event);
    }

    expect(toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    const followUpArgs = llmManager.streamProvider.mock.calls[1];
    expect(followUpArgs[4]).toEqual([]);
    expect(followUpArgs[5]).toBe('none');
    // Stream now emits {type: "DONE", response: {...}} and {type: "delta", content: "..."}
    expect(events[events.length - 1].type).toBe('done');
    expect(events[events.length - 1].response).toBeDefined();
    expect(events.find(e => e.type === 'delta' && e.content === 'summary')).toBeDefined();
  });

  // extractStreamText method was removed in favor of compat.parseStreamChunk()
  // Text extraction is now handled by each compat module

  test('coordinateStream fills missing event metadata and defaults', async () => {
    const followUpStream = (async function* () {
      yield { choices: [{ delta: { content: 'done' } }] };
    })();

    let parseCallCount = 0;
    const { coordinator, llmManager, toolCoordinator } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          // First chunk returns tool events
          if (parseCallCount === 1) {
            return {
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool.raw' }
              ]
            };
          }
          // Follow-up chunks
          return {
            text: chunk.choices?.[0]?.delta?.content,
            toolEvents: undefined
          };
        })
      },
      llmManager: {
        streamProvider: jest
          .fn()
          .mockReturnValueOnce((async function* () {
            yield { choices: [{}] };
          })())
          .mockReturnValueOnce(followUpStream)
      },
      toolCoordinator: {
        routeAndInvoke: jest.fn().mockResolvedValue('string-result')
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {},
      metadata: {}
    };

    const context = createContext();
    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool.raw' }], context)) {
      events.push(event);
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.raw',
      '1',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
    const toolResultEvent = events.find(
      e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT
    );
    expect(toolResultEvent?.toolEvent?.arguments).toBe(JSON.stringify('string-result'));
    // Stream now emits {type: "DONE", response: {...}} and {type: "delta", content: "..."}
    expect(events[events.length - 1].type).toBe('done');
    expect(events[events.length - 1].response).toBeDefined();
    expect(events.find(e => e.type === 'delta' && e.content === 'done')).toBeDefined();
  });

  test('coordinateStream handles missing tool name with unknown fallback', async () => {
    const followUpStream = (async function* () {
      yield { choices: [{ delta: { content: 'recovered' } }] };
    })();

    let parseCallCount = 0;
    const { coordinator, llmManager, toolCoordinator } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          // First chunk returns tool events
          if (parseCallCount === 1) {
            return {
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '2' },
                // Tool call end with no name - should use 'unknown'
                { type: ToolCallEventType.TOOL_CALL_END, callId: '2', arguments: '{}' }
              ]
            };
          }
          // Follow-up chunks
          return {
            text: chunk.choices?.[0]?.delta?.content,
            toolEvents: undefined
          };
        })
      },
      llmManager: {
        streamProvider: jest
          .fn()
          .mockReturnValueOnce((async function* () {
            yield { choices: [{}] };
          })())
          .mockReturnValueOnce(followUpStream)
      },
      toolCoordinator: {
        routeAndInvoke: jest.fn().mockResolvedValue({ fallback: true })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: {},
      metadata: {}
    };

    const context = createContext();
    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool.test' }], context)) {
      events.push(event);
    }

    // When name is not in the tool call, it should use undefined (not 'unknown')
    // The 'unknown' fallback is in different code path - let's verify the tool was called
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'unknown_tool',
      '2',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
  });

  test('coordinateStream preserves metadata (e.g., thoughtSignature) on tool calls', async () => {
    const thoughtSignature = 'EpwCCpkCAXLI2nwMdJvMR...';
    const streamResponses = [
      (async function* () {
        yield { choices: [{ delta: { content: 'pre-tool' } }] };
      })(),
      (async function* () {
        yield { choices: [{ delta: { content: 'post-tool' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, toolCoordinator } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 1) {
            return {
              text: chunk.choices?.[0]?.delta?.content,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: 'meta-1', name: 'tool_with_sig', metadata: { thoughtSignature } },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'meta-1', argumentsDelta: '{"x":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: 'meta-1', name: 'tool_with_sig', arguments: '{"x":1}' }
              ]
            };
          }
          return {
            text: chunk.choices?.[0]?.delta?.content,
            toolEvents: undefined
          };
        })
      },
      llmManager: {
        streamProvider: jest.fn(() => streamResponses.shift()!)
      },
      toolCoordinator: {
        routeAndInvoke: jest.fn().mockResolvedValue({ ok: true })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 2, toolCountdownEnabled: false },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['tool_with_sig', 'tool.withSignature']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool.withSignature' }], context)) {
      events.push(event);
    }

    // Find the tool_call events - they should have metadata preserved
    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    expect(toolCallEvents.length).toBeGreaterThan(0);

    // Check that metadata with thoughtSignature is preserved
    const firstToolCall = toolCallEvents[0];
    expect(firstToolCall.toolCall.metadata).toBeDefined();
    expect(firstToolCall.toolCall.metadata.thoughtSignature).toBe(thoughtSignature);

    // Also check the final DONE response has the metadata
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent.response.toolCalls).toBeDefined();
    expect(doneEvent.response.toolCalls[0].metadata).toEqual({ thoughtSignature });
  });

  test('coordinateStream preserves metadata when finalizing pending state without TOOL_CALL_END', async () => {
    const thoughtSignature = 'pending-state-signature...';
    const streamResponses = [
      (async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
      })(),
      (async function* () {
        yield { choices: [{ delta: { content: 'follow-up' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, toolCoordinator } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 1) {
            return {
              text: chunk.choices?.[0]?.delta?.content,
              // Only TOOL_CALL_START with metadata, no TOOL_CALL_END
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: 'pending-1', name: 'pending_tool', metadata: { thoughtSignature } },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'pending-1', argumentsDelta: '{}' }
              ],
              // Signal that we finished with tool calls so the finalization path is triggered
              finishedWithToolCalls: true
            };
          }
          return {
            text: chunk.choices?.[0]?.delta?.content,
            toolEvents: undefined
          };
        })
      },
      llmManager: {
        streamProvider: jest.fn(() => streamResponses.shift()!)
      },
      toolCoordinator: {
        routeAndInvoke: jest.fn().mockResolvedValue({ ok: true })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 2, toolCountdownEnabled: false },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['pending_tool', 'pending.tool']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'pending.tool' }], context)) {
      events.push(event);
    }

    // The pending finalization path should have preserved metadata
    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    expect(toolCallEvents.length).toBeGreaterThan(0);
    expect(toolCallEvents[0].toolCall.metadata).toEqual({ thoughtSignature });
  });
});
