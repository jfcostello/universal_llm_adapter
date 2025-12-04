import { jest } from '@jest/globals';
import { StreamCoordinator } from '@/coordinator/stream-coordinator.ts';
import { StreamEventType, ToolCallEventType } from '@/core/types.ts';
import { ToolCallBudget } from '@/utils/tools/tool-budget.ts';
import OpenAICompat from '@/plugins/compat/openai.ts';

interface MockOptions {
  toolCountdownEnabled?: boolean;
  maxToolIterations?: number;
  toolNameMap?: Map<string, string>;
  initialChunks?: any[];
  followUpChunks?: any[];
  toolResult?: any;
  tools?: any[];
  toolChoice?: string;
  followUpError?: Error;
}

function createCoordinatorMocks(options: MockOptions = {}) {
  const {
    toolCountdownEnabled = true,
    maxToolIterations = 2,
    toolNameMap = new Map<string, string>(),
    initialChunks = [
      {
        choices: [
          {
            delta: {
              content: 'Hi',
              tool_calls: [
                {
                  id: 'call-1',
                  function: {
                    name: 'echo.text',
                    arguments: '{"text":"value"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      }
    ],
    followUpChunks = [
      {
        choices: [
          {
            delta: { content: 'follow-up' }
          }
        ]
      }
    ],
    toolResult = { result: { echoed: 'tool-output' } },
    tools = [],
    toolChoice,
    followUpError
  } = options;

  const spec: any = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      }
    ],
    llmPriority: [{ provider: 'test-openai', model: 'stub' }],
    settings: {
      maxToolIterations,
      toolCountdownEnabled
    },
    metadata: {},
    toolChoice
  };

  const registry = {
    getProvider: jest.fn(() => ({ id: 'test-openai', compat: 'openai' })),
    getCompatModule: jest.fn(() => new OpenAICompat())
  } as any;

  const streamProvider = jest
    .fn()
    .mockImplementationOnce(async function* () {
      for (const chunk of initialChunks) {
        yield chunk;
      }
    })
    .mockImplementationOnce(async function* () {
      if (followUpError) {
        throw followUpError;
      }
      for (const chunk of followUpChunks) {
        yield chunk;
      }
    });

  const llmManager = { streamProvider } as any;
  const toolCoordinator = {
    routeAndInvoke: jest.fn().mockResolvedValue(toolResult)
  } as any;

  const logger = { info: jest.fn() } as any;

  const coordinator = new StreamCoordinator(registry, llmManager, toolCoordinator);

  const context = {
    provider: 'test-openai',
    model: 'stub',
    tools,
    mcpServers: [],
    toolNameMap,
    logger
  };

  return { coordinator, registry, llmManager, toolCoordinator, context, spec };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('StreamCoordinator', () => {
  test('handles tool call follow-up and remaps tool names when countdown disabled', async () => {
    const toolNameMap = new Map<string, string>([['echo_text', 'alias.echo']]);
    const { coordinator, context, llmManager, toolCoordinator, spec } = createCoordinatorMocks({
      toolCountdownEnabled: false,
      toolNameMap
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    expect(events.filter(e => e.type === StreamEventType.TOOL)).toHaveLength(4); // start, delta, end, result
    const resultEvent = events.find(
      e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT
    );
    expect(resultEvent?.toolEvent?.name).toBe('alias.echo');
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'alias.echo',
      'call-1',
      { text: 'value' },
      expect.objectContaining({ provider: 'test-openai', model: 'stub' })
    );
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    // Stream now emits {type: "delta", content: "..."}
    expect(events.at(-2)).toMatchObject({ type: 'delta', content: 'follow-up' });
    const invokeCall = context.logger.info.mock.calls.find(
      ([message]) => message === 'Invoking tool'
    );
    expect(invokeCall?.[1]).toEqual({
      toolName: 'alias.echo',
      callId: 'call-1'
    });
  });

  test('respects tool budget exhaustion and clears tools for follow-up stream', async () => {
    const { coordinator, context, llmManager, toolCoordinator, spec } = createCoordinatorMocks({
      maxToolIterations: 0,
      followUpChunks: [
        {
          choices: [
            {
              delta: { content: 'final' }
            }
          ]
        }
      ]
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    expect(toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();
    expect(events.some(e => e.type === StreamEventType.TOOL)).toBe(true);
    // Stream now emits {type: "delta", content: "..."}
    expect(events.find(e => e.type === 'delta' && e.content === 'final')).toBeDefined();
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    const followUpArgs = llmManager.streamProvider.mock.calls[1];
    expect(followUpArgs[4]).toEqual([]); // tools cleared
    expect(followUpArgs[5]).toBe('none');
  });

  test('emits tokens without tool events', async () => {
    const { coordinator, context, llmManager, spec } = createCoordinatorMocks({
      initialChunks: [
        {
          choices: [
            {
              delta: { content: 'chunk-1' }
            }
          ]
        }
      ],
      followUpChunks: []
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    // Stream now emits {type: "delta", content: "..."} and {type: "DONE", response: {...}}
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'delta', content: 'chunk-1' });
    expect(events[1].type).toBe('done');
    expect(events[1].response).toBeDefined();
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(1);
  });

  test('handleStreamingToolCalls stops when consume declines iteration', async () => {
    const { coordinator, context, llmManager, toolCoordinator, spec } = createCoordinatorMocks();
    const originalConsume = ToolCallBudget.prototype.consume;
    const consumeSpy = jest.spyOn(ToolCallBudget.prototype, 'consume').mockImplementation(function (this: ToolCallBudget, amount = 1) {
      consumeSpy.mockImplementation(function (this: ToolCallBudget, amount = 1) {
        return originalConsume.call(this, amount);
      });
      return false;
    });

    const events: any[] = [];
    try {
      for await (const event of coordinator.coordinateStream(
        spec,
        [...spec.messages],
        [],
        context
      )) {
        events.push(event);
      }
    } finally {
      consumeSpy.mockRestore();
    }

    expect(toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === StreamEventType.TOOL).length).toBeGreaterThan(0);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
  });

  test('aggregates partial tool argument chunks into one parsed tool call', async () => {
    const { coordinator, context, spec } = createCoordinatorMocks({
      initialChunks: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      name: 'echo.text',
                      arguments: '{"text":"part'
                    }
                  }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      arguments: 'ial"}'
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      ],
      followUpChunks: []
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    expect(toolCallEvents.length).toBeGreaterThan(0);
    const finalToolCall = toolCallEvents.at(-1)!.toolCall;
    expect(finalToolCall).toMatchObject({
      id: 'call-1',
      name: 'echo.text',
      arguments: { text: 'partial' }
    });
  });

  test('propagates follow-up stream errors to the caller', async () => {
    const { coordinator, context, spec } = createCoordinatorMocks({
      followUpError: new Error('follow-up failed')
    });

    const iterator = coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    );

    const drain = async () => {
      for await (const _ of iterator) {
        // consume
      }
    };

    await expect(drain()).rejects.toThrow('follow-up failed');
  });

  test('combines text chunks into DONE response when no tool calls detected', async () => {
    const { coordinator, context, spec } = createCoordinatorMocks({
      initialChunks: [
        {
          choices: [
            {
              delta: { content: 'Hello ' }
            }
          ]
        },
        {
          choices: [
            {
              delta: { content: 'world!' },
              finish_reason: 'stop'
            }
          ]
        }
      ],
      followUpChunks: []
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.response.content[0].text).toBe('Hello world!');
    expect(doneEvent.response.finishReason).toBe('stop');
  });

  test('truncates tool results according to runtime settings during streaming follow-up', async () => {
    const longResult = { result: 'Z'.repeat(40) };
    const { coordinator, context, llmManager, toolCoordinator, spec } = createCoordinatorMocks({
      toolResult: longResult,
      followUpChunks: [
        {
          choices: [
            {
              delta: { content: 'done' },
              finish_reason: 'stop'
            }
          ]
        }
      ]
    });

    spec.settings.toolResultMaxChars = 10;

    const messageHistory = [...spec.messages];
    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      messageHistory,
      [],
      context
    )) {
      events.push(event);
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalled();
    const toolMessages = messageHistory.filter(msg => msg.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const textEntries = toolMessages[0].content.filter((part: any) => part.type === 'text');
    expect(textEntries.some((part: any) => /…$/.test(part.text))).toBe(true);
    expect(textEntries.some((part: any) => /truncated/i.test(part.text))).toBe(true);

    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.some(e => e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)).toBe(true);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
  });

  test('waits for MCP tool invocation before resuming follow-up stream and remaps tool names', async () => {
    const { coordinator, context, llmManager, toolCoordinator, spec } = createCoordinatorMocks({
      toolNameMap: new Map<string, string>([['localmcp_echo', 'localmcp.echo']]),
      initialChunks: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      name: 'localmcp_echo',
                      arguments: '{"text":"value"}'
                    }
                  }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      arguments: ''
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      ],
      followUpChunks: [
        {
          choices: [
            {
              delta: { content: 'back-online' },
              finish_reason: 'stop'
            }
          ]
        }
      ]
    });

    const deferred = createDeferred<any>();
    toolCoordinator.routeAndInvoke.mockImplementation(async () => {
      await deferred.promise;
      return { result: { echo: 'done' } };
    });

    const iterator = coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    );

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(1);
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledTimes(0);

    deferred.resolve(undefined);

    const events: any[] = [];
    if (!first.done) {
      events.push(first.value);
    }
    for await (const event of iterator) {
      events.push(event);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledTimes(1);
    const [toolName, callId, args, callContext] = toolCoordinator.routeAndInvoke.mock.calls[0];
    expect(toolName).toBe('localmcp.echo');
    expect(callId).toBe('call-1');
    expect(args).toEqual({ text: 'value' });
    expect(callContext).toEqual(expect.objectContaining({ provider: 'test-openai', model: 'stub' }));
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.response.content[0].text).toContain('back-online');
  });

  test('emits token usage events and updates final usage snapshot', async () => {
    const { coordinator, context, spec } = createCoordinatorMocks({
      initialChunks: [
        {
          choices: [
            {
              delta: { content: 'chunk1' }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11
          }
        },
        {
          choices: [
            {
              delta: { content: 'chunk2' },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15
          }
        }
      ],
      followUpChunks: []
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    const tokenEvents = events.filter(e => e.type === StreamEventType.TOKEN);
    expect(tokenEvents).toHaveLength(2);
    expect(tokenEvents[0]?.metadata?.usage?.totalTokens).toBe(11);
    expect(tokenEvents[1]?.metadata?.usage?.totalTokens).toBe(15);

    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.response.usage?.totalTokens).toBe(15);
  });

  test('aggregates reasoning deltas into final response reasoning field', async () => {
    const { coordinator, context, spec } = createCoordinatorMocks({
      initialChunks: [
        {
          choices: [
            {
              delta: {
                content: 'First ',
                reasoning: { text: 'Step 1. ' }
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                content: 'Second',
                reasoning: { text: 'Step 2.' }
              },
              finish_reason: 'stop'
            }
          ]
        }
      ],
      followUpChunks: []
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.response.reasoning?.text).toBe('Step 1. Step 2.');
    const tokenEvents = events.filter(e => e.type === StreamEventType.TOKEN);
    expect(tokenEvents.length).toBe(0); // no usage emitted
  });

  test('merges reasoning metadata from follow-up tool loop responses', async () => {
    const { coordinator, context, spec } = createCoordinatorMocks({
      initialChunks: [
        {
          choices: [
            {
              delta: {
                reasoning: { text: 'Primary reasoning. ', metadata: { stage: 'primary' } },
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      name: 'echo.text',
                      arguments: '{"value":'
                    }
                  }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      arguments: '1}'
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      ],
      followUpChunks: [
        {
          choices: [
            {
              delta: {
                content: 'final',
                reasoning: { text: 'Secondary reasoning.', metadata: { stage: 'followup' } }
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7
          }
        }
      ]
    });

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    )) {
      events.push(event);
    }

    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.response.reasoning?.text).toBe('Primary reasoning. Secondary reasoning.');
    expect(doneEvent?.response.reasoning?.metadata).toEqual(expect.objectContaining({ stage: 'followup' }));
    expect(doneEvent?.response.usage?.totalTokens).toBe(7);
  });

  test('resumes streaming after consumer pauses iteration', async () => {
    const { coordinator, context, llmManager, toolCoordinator, spec } = createCoordinatorMocks();

    const iterator = coordinator.coordinateStream(
      spec,
      [...spec.messages],
      [],
      context
    );

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toHaveProperty('type');
    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledTimes(0);

    const collected: any[] = [];
    for await (const event of iterator) {
      collected.push(event);
    }

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledTimes(1);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    const doneEvent = collected.find(event => event.type === 'done');
    expect(doneEvent?.response.content[0].text).toContain('follow-up');
  });

  // extractStreamText method was removed - text extraction now handled by compat.parseStreamChunk()
});
