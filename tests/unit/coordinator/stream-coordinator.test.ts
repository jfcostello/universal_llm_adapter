import { jest } from '@jest/globals';
import { StreamCoordinator } from '@/modules/llm/index.ts';
import { StreamEventType, ToolCallEventType, Role } from '@/kernel/index.ts';
import { calculateUsageCost } from '@/modules/usage-cost/index.ts';

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

  test('coordinateStream retries tool_choice-required stream when no tool calls are emitted (before first delta)', async () => {
    const streamResponses = [
      // Attempt 1: no text deltas, no tool events => triggers retry.
      (async function* () {
        yield { choices: [{}] };
      })(),
      // Attempt 2: emits a tool call.
      (async function* () {
        yield { choices: [{}] };
      })(),
      // Follow-up after tool execution.
      (async function* () {
        yield { choices: [{ delta: { content: 'final' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, llmManager, toolCoordinator, compatModule } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 2) {
            return {
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_raw' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_raw', arguments: '{}' }
              ],
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
        routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 2 },
      toolChoice: { type: 'required', allowed: ['tool_raw'] },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['tool_raw', 'tool.raw']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool_raw' }], context, { requireFinishToExecute: true })) {
      events.push(event);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
    const retryMessages = llmManager.streamProvider.mock.calls[1]?.[3] ?? [];
    expect(Array.isArray(retryMessages)).toBe(true);
    expect(retryMessages.some((m: any) => m?.role === Role.USER && JSON.stringify(m?.content || []).includes('You MUST call the required tool now.'))).toBe(true);
    expect(compatModule.parseStreamChunk).toHaveBeenCalled();
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.raw',
      '1',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
    expect(events.some(e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('coordinateStream retries required tool_choice streams even when text is emitted before a tool call', async () => {
    const streamResponses = [
      // Attempt 1: emits text but no tool calls => should be suppressed and retried.
      (async function* () {
        yield { choices: [{ delta: { content: 'should-not-leak' } }] };
      })(),
      // Attempt 2: emits a tool call.
      (async function* () {
        yield { choices: [{}] };
      })(),
      // Follow-up after tool execution.
      (async function* () {
        yield { choices: [{ delta: { content: 'final' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, llmManager, toolCoordinator, compatModule } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 2) {
            return {
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_raw' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_raw', arguments: '{}' }
              ],
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
        routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 2 },
      toolChoice: { type: 'required', allowed: ['tool_raw'] },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['tool_raw', 'tool.raw']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool_raw' }], context, { requireFinishToExecute: true })) {
      events.push(event);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
    const retryMessages = llmManager.streamProvider.mock.calls[1]?.[3] ?? [];
    expect(Array.isArray(retryMessages)).toBe(true);
    expect(retryMessages.some((m: any) => m?.role === Role.USER && JSON.stringify(m?.content || []).includes('You MUST call the required tool now.'))).toBe(true);
    expect(compatModule.parseStreamChunk).toHaveBeenCalled();
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.raw',
      '1',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );

    const deltas = events.filter(e => e.type === StreamEventType.DELTA).map(e => e.content);
    expect(deltas).toContain('final');
    expect(deltas).not.toContain('should-not-leak');
    expect(events.at(-1)?.response?.content?.[0]?.text).toBe('final');
  });

  test('coordinateStream flushes buffered required text before tool events in the same chunk', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{ delta: { content: 'preface' } }] };
      })(),
      (async function* () {
        yield { choices: [{ delta: { content: 'final' } }] };
      })()
    ];
    let parseCallCount = 0;

    const { coordinator, llmManager, toolCoordinator } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 1) {
            return {
              text: chunk.choices?.[0]?.delta?.content,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_raw' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_raw', arguments: '{}' }
              ],
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
        routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 2 },
      toolChoice: { type: 'required', allowed: ['tool_raw'] },
      metadata: {}
    };

    const context = createContext();
    context.toolNameMap = new Map([['tool_raw', 'tool.raw']]);

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool_raw' }], context, { requireFinishToExecute: true })) {
      events.push(event);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.raw',
      '1',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );

    const deltaEvents = events.filter(e => e.type === StreamEventType.DELTA);
    expect(deltaEvents[0]?.content).toBe('preface');
    expect(deltaEvents.some(e => e.content === 'final')).toBe(true);
  });

  test('coordinateStream flushes buffered required text when stream ends with tool finish and no tool events', async () => {
    const { coordinator, llmManager } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => ({
          text: chunk.choices?.[0]?.delta?.content,
          toolEvents: undefined,
          finishedWithToolCalls: true
        }))
      },
      llmManager: {
        streamProvider: jest.fn(async function* () {
          yield { choices: [{ delta: { content: 'buffered-final' } }] };
        })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 1 },
      toolChoice: { type: 'required', allowed: ['tool_raw'] },
      metadata: {}
    };

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool_raw' }], createContext(), { requireFinishToExecute: true })) {
      events.push(event);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === StreamEventType.DELTA && e.content === 'buffered-final')).toBe(true);
    expect(events.at(-1)?.response?.content?.[0]?.text).toBe('buffered-final');
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
    const toolCallEvents = events.filter(e => e.type === 'tool_call');

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

    // Ensure tool_call events and DONE.toolCalls are not duplicated.
	    expect(toolCallEvents.filter(e => e.toolCall?.id === '1').length).toBe(1);
	    expect(doneEvents[0].response.toolCalls?.filter((tc: any) => tc.id === '1').length).toBe(1);
	  });

    test('coordinateStream streams TOOL_RESULT events in completion order when parallelToolExecution is enabled', async () => {
      const streamResponses = [
        (async function* () {
          yield { choices: [{ delta: { content: 'pre-tool' } }] };
        })(),
        (async function* () {
          yield { choices: [{ delta: { content: 'final' } }] };
        })()
      ];

      let parseCallCount = 0;

      let resolveTool1: ((value: any) => void) | undefined;
      const tool1Promise = new Promise(res => {
        resolveTool1 = res;
      });
      const tool2Promise = Promise.resolve({ result: { ok: true } });

      const { coordinator, llmManager, toolCoordinator, compatModule } = createCoordinator({
        compatModule: {
          parseStreamChunk: jest.fn((chunk: any) => {
            parseCallCount++;
            if (parseCallCount === 1) {
              return {
                text: chunk.choices?.[0]?.delta?.content,
                toolEvents: [
                  { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool.sanitized.one' },
                  { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{}' },
                  { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool.sanitized.one', arguments: '{}' },
                  { type: ToolCallEventType.TOOL_CALL_START, callId: '2', name: 'tool.sanitized.two' },
                  { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '2', argumentsDelta: '{}' },
                  { type: ToolCallEventType.TOOL_CALL_END, callId: '2', name: 'tool.sanitized.two', arguments: '{}' }
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
          routeAndInvoke: jest.fn((toolName: string, callId: string) => {
            if (callId === '1') return tool1Promise;
            if (callId === '2') return tool2Promise;
            throw new Error('unexpected tool call');
          })
        }
      });

      // Ensure tool 1 resolves after tool 2 in parallel mode, but still resolves quickly in sequential mode.
      setImmediate(() => resolveTool1?.({ result: { ok: true } }));

      const spec: any = {
        llmPriority: [{ provider: 'provider', model: 'model' }],
        settings: { maxToolIterations: 5, parallelToolExecution: true },
        metadata: {}
      };

      const context = createContext();
      context.toolNameMap = new Map([
        ['tool.sanitized.one', 'tool.one'],
        ['tool.sanitized.two', 'tool.two']
      ]);

      const events: any[] = [];
      for await (const event of coordinator.coordinateStream(
        spec,
        [],
        [{ name: 'tool.one' }, { name: 'tool.two' }],
        context
      )) {
        events.push(event);
      }

      expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
      expect(compatModule.parseStreamChunk).toHaveBeenCalled();
      expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledTimes(2);

      const toolResultEvents = events.filter(
        e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT
      );
      expect(toolResultEvents.map((e: any) => e.toolEvent.callId)).toEqual(['2', '1']);
    });

    test('coordinateStream executes tool calls emitted in follow-up stream', async () => {
      const streamResponses = [
        (async function* () {
          yield { choices: [{ delta: { content: 'pre-tool' } }] };
        })(),
        (async function* () {
          yield { choices: [{}] };
        })(),
        (async function* () {
          yield { choices: [{ delta: { content: 'final' } }] };
        })()
      ];

      let parseCallCount = 0;
      const { coordinator, llmManager, toolCoordinator, compatModule } = createCoordinator({
        compatModule: {
          parseStreamChunk: jest.fn((chunk: any) => {
            parseCallCount++;
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

            if (parseCallCount === 2) {
              return {
                text: undefined,
                toolEvents: [
                  { type: ToolCallEventType.TOOL_CALL_START, callId: '2', name: 'tool.sanitized' },
                  { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '2', argumentsDelta: '{"b":2}' },
                  { type: ToolCallEventType.TOOL_CALL_END, callId: '2', name: 'tool.sanitized', arguments: '{"b":2}' }
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
          routeAndInvoke: jest.fn().mockResolvedValue({ result: 'ok' })
        }
      });

      const spec: any = {
        llmPriority: [{ provider: 'provider', model: 'model' }],
        settings: { maxToolIterations: 5 },
        metadata: {}
      };

      const context = createContext();
      context.toolNameMap = new Map([['tool.sanitized', 'tool.raw']]);

      const events: any[] = [];
      for await (const event of coordinator.coordinateStream(spec, [], [{ name: 'tool.raw' }], context)) {
        events.push(event);
      }

      expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
      expect(compatModule.parseStreamChunk).toHaveBeenCalled();

      expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
        'tool.raw',
        '1',
        { a: 1 },
        expect.objectContaining({ provider: 'provider', model: 'model' })
      );
      expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
        'tool.raw',
        '2',
        { b: 2 },
        expect.objectContaining({ provider: 'provider', model: 'model' })
      );

      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      expect(toolCallEvents.map((e: any) => e.toolCall?.id)).toEqual(['1', '2']);

      const done = events.find(e => e.type === 'done');
      expect(done?.response?.toolCalls?.map((tc: any) => tc.id)).toEqual(['1', '2']);
    });

	  test('coordinateStream ignores pending tool-call state for already-detected callIds', async () => {
	    const streamResponses = [
	      (async function* () {
	        yield { choices: [{ delta: { content: 'token-1' } }] };
	      })(),
	      (async function* () {
	        yield { choices: [{ delta: { content: 'follow-up' } }] };
	      })()
	    ];

	    let parseCallCount = 0;
	    const { coordinator, llmManager, toolCoordinator, compatModule } = createCoordinator({
	      compatModule: {
	        parseStreamChunk: jest.fn((chunk: any) => {
	          parseCallCount++;
	          if (parseCallCount === 1) {
	            return {
	              text: chunk.choices?.[0]?.delta?.content,
	              toolEvents: [
	                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool.sanitized' },
	                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool.sanitized', arguments: '{}' },
	                // Duplicate START reintroduces pending state after the callId has been detected.
	                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool.sanitized' }
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
	      {},
	      expect.objectContaining({ provider: 'provider', model: 'model' })
	    );

	    const toolCallEvents = events.filter(e => e.type === 'tool_call');
	    const doneEvents = events.filter(e => e.type === 'done');

	    expect(toolCallEvents.filter(e => e.toolCall?.id === '1').length).toBe(1);
	    expect(doneEvents[0].response.toolCalls?.filter((tc: any) => tc.id === '1').length).toBe(1);
	  });

	  test('coordinateStream does not crash on malformed tool-call args JSON', async () => {
	    const streamResponses = [
	      (async function* () {
        yield { choices: [{ delta: { content: 'token-1' } }] };
      })(),
      (async function* () {
        yield { choices: [{ delta: { content: 'follow-up' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, llmManager, toolCoordinator, compatModule } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 1) {
            return {
              text: chunk.choices?.[0]?.delta?.content,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: 'bad-1', name: 'tool.sanitized' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'bad-1', argumentsDelta: '}{' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: 'bad-1', name: 'tool.sanitized', arguments: '}{' }
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
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.original',
      'bad-1',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
    expect(events.at(-1)?.type).toBe('done');
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

  test('coordinateStream normalizes usageCost flags and attaches usage cost when enabled', async () => {
    const baseUsage = { promptTokens: 10, completionTokens: 5, cachedTokens: 2 };
    const compatModule = {
      parseStreamChunk: jest.fn(() => ({
        text: 'hello',
        usage: { ...baseUsage }
      }))
    };

    const { coordinator } = createCoordinator({
      compatModule,
      registry: {
        getProvider: jest.fn(() => ({ id: 'example-provider', compat: 'openai' })),
        getCompatModule: jest.fn(() => compatModule)
      },
      llmManager: {
        streamProvider: jest.fn(async function* () {
          yield { choices: [{ delta: { content: 'hello' } }] };
        })
      }
    });

    const context = createContext();
    context.provider = 'example-provider';
    context.model = 'example-model';

    const baseSpec: any = {
      llmPriority: [{ provider: 'example-provider', model: 'example-model' }],
      settings: {}
    };

    const run = async (usageCost: any) => {
      const spec = { ...baseSpec, settings: { usageCost } };
      const events: any[] = [];
      for await (const event of coordinator.coordinateStream(spec, [], [], context)) {
        events.push(event);
      }
      return events.at(-1)?.response?.usage;
    };

    const expected = calculateUsageCost({
      provider: 'example-provider',
      model: 'example-model',
      usage: baseUsage
    });

    const usageWithCost = await run(true);
    expect(usageWithCost?.cost).toBe(expected);

    await run(false);
    await run(1);
    await run('yes');
    await run('off');
    await run('maybe');
    await run({});
  });

  test('coordinateStream skips usage cost when tokens are missing', async () => {
    const compatModule = {
      parseStreamChunk: jest
        .fn()
        .mockImplementationOnce(() => ({
          text: 'hello',
          usage: { promptTokens: 10 }
        }))
        .mockImplementationOnce(() => ({
          text: 'hello',
          usage: { completionTokens: 5 }
        }))
    };

    const { coordinator } = createCoordinator({
      compatModule,
      registry: {
        getProvider: jest.fn(() => ({ id: 'example-provider', compat: 'openai' })),
        getCompatModule: jest.fn(() => compatModule)
      },
      llmManager: {
        streamProvider: jest.fn(async function* () {
          yield { choices: [{ delta: { content: 'hello' } }] };
        })
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'example-provider', model: 'example-model' }],
      settings: { usageCost: true }
    };

    const context = createContext();
    context.provider = 'example-provider';
    context.model = 'example-model';

    const runOnce = async () => {
      const events: any[] = [];
      for await (const event of coordinator.coordinateStream(spec, [], [], context)) {
        events.push(event);
      }
      return events.at(-1);
    };

    const doneMissingCompletion = await runOnce();
    expect(doneMissingCompletion?.response?.usage?.cost).toBeUndefined();

    const doneMissingPrompt = await runOnce();
    expect(doneMissingPrompt?.response?.usage?.cost).toBeUndefined();
  });

  test('stream tool routing: schemaName is empty when call.name is missing', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{}] };
      })(),
      (async function* () {
        yield { choices: [{ delta: { content: 'follow-up' } }] };
      })()
    ];

    let parseCallCount = 0;
    const { coordinator, toolCoordinator, compatModule, llmManager } = createCoordinator({
      compatModule: {
        parseStreamChunk: jest.fn((chunk: any) => {
          parseCallCount++;
          if (parseCallCount === 1) {
            return {
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: undefined },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{"a":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: undefined, arguments: '{"a":1}' }
              ]
            };
          }
          return { text: chunk.choices?.[0]?.delta?.content, toolEvents: undefined };
        })
      },
      llmManager: { streamProvider: jest.fn(() => streamResponses.shift()!) },
      toolCoordinator: { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 1 },
      metadata: {}
    };
    const context = createContext();

    for await (const _ of coordinator.coordinateStream(spec, [], [], context)) {
      // drain
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    expect(compatModule.parseStreamChunk).toHaveBeenCalled();
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'unknown_tool',
      '1',
      { a: 1 },
      expect.objectContaining({ toolId: undefined, processRouteId: undefined })
    );
  });

  test('stream tool routing: schemaName is empty when call.name is whitespace', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{}] };
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
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: '   ' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{"a":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: '   ', arguments: '{"a":1}' }
              ]
            };
          }
          return { text: chunk.choices?.[0]?.delta?.content, toolEvents: undefined };
        })
      },
      llmManager: { streamProvider: jest.fn(() => streamResponses.shift()!) },
      toolCoordinator: { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 1 },
      metadata: {}
    };
    const context = createContext();

    for await (const _ of coordinator.coordinateStream(spec, [], [], context)) {
      // drain
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      '   ',
      '1',
      { a: 1 },
      expect.objectContaining({ toolId: undefined, processRouteId: undefined })
    );
  });

  test('stream tool routing: direct schema match falls back when routesById maps to whitespace', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{}] };
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
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_sanitized' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{"a":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_sanitized', arguments: '{"a":1}' }
              ]
            };
          }
          return { text: chunk.choices?.[0]?.delta?.content, toolEvents: undefined };
        })
      },
      llmManager: { streamProvider: jest.fn(() => streamResponses.shift()!) },
      toolCoordinator: { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 1 },
      toolRouting: { routesById: { 'tool-123': '   ' } },
      metadata: {}
    };
    const context = createContext();
    context.toolNameMap = new Map([['tool_sanitized', 'tool.original']]);

    const tools = [{ name: 'tool_sanitized', id: 'tool-123', processRouteId: 'route-tool' }];

    for await (const _ of coordinator.coordinateStream(spec, [], tools as any, context)) {
      // drain
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.original',
      '1',
      { a: 1 },
      expect.objectContaining({ toolId: 'tool-123', processRouteId: 'route-tool' })
    );
  });

  test('stream tool routing: falls back to sanitizeToolName(call.name) for tool definition lookup', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{}] };
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
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool.sanitized' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{"a":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool.sanitized', arguments: '{"a":1}' }
              ]
            };
          }
          return { text: chunk.choices?.[0]?.delta?.content, toolEvents: undefined };
        })
      },
      llmManager: { streamProvider: jest.fn(() => streamResponses.shift()!) },
      toolCoordinator: { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 1 },
      toolRouting: { routesById: { 'tool-123': 'route-runtime-id' } },
      metadata: {}
    };
    const context = createContext();
    context.toolNameMap = new Map([['tool_sanitized', 'tool.original']]);

    const tools = [{ name: 'tool_sanitized', id: 'tool-123', processRouteId: 'route-tool' }];

    for await (const _ of coordinator.coordinateStream(spec, [], tools as any, context)) {
      // drain
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.original',
      '1',
      { a: 1 },
      expect.objectContaining({ toolId: 'tool-123', processRouteId: 'route-runtime-id' })
    );
  });

  test('stream tool routing: treats blank tool id/processRouteId as undefined', async () => {
    const streamResponses = [
      (async function* () {
        yield { choices: [{}] };
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
              text: undefined,
              toolEvents: [
                { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'tool_sanitized' },
                { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '1', argumentsDelta: '{"a":1}' },
                { type: ToolCallEventType.TOOL_CALL_END, callId: '1', name: 'tool_sanitized', arguments: '{"a":1}' }
              ]
            };
          }
          return { text: chunk.choices?.[0]?.delta?.content, toolEvents: undefined };
        })
      },
      llmManager: { streamProvider: jest.fn(() => streamResponses.shift()!) },
      toolCoordinator: { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) }
    });

    const spec: any = {
      llmPriority: [{ provider: 'provider', model: 'model' }],
      settings: { maxToolIterations: 1 },
      metadata: {}
    };
    const context = createContext();
    context.toolNameMap = new Map([['tool_sanitized', 'tool.original']]);

    const tools = [{ name: 'tool_sanitized', id: '   ', processRouteId: '  ' }];

    for await (const _ of coordinator.coordinateStream(spec, [], tools as any, context)) {
      // drain
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'tool.original',
      '1',
      { a: 1 },
      expect.objectContaining({ toolId: undefined, processRouteId: undefined })
    );
  });

});
