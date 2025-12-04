import { jest } from '@jest/globals';
import { PluginRegistry } from '@/core/registry.ts';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { Role, StreamEventType, ToolCallEventType } from '@/core/types.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

const spec = {
  messages: [
    {
      role: Role.USER,
      content: [{ type: 'text', text: 'stream please' }]
    }
  ],
  llmPriority: [
    { provider: 'test-openai', model: 'stub-model' }
  ],
  settings: {
    temperature: 0
  },
  metadata: { correlationId: 'stream-test' }
};

describe('coordinator/runStream', () => {
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

  test('yields token and tool events from stream', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const processRoutes = await registry.getProcessRoutes();
    processRoutes.forEach(route => {
      route.timeoutMs = 10;
    });
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      yield {
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
            }
          }
        ]
      };
    });

    const events: any[] = [];
    for await (const event of coordinator.runStream(spec as any)) {
      events.push(event);
    }

    // Stream now emits {type: "delta", content: "..."} and {type: "DONE", response: {...}}
    expect(events[0]).toMatchObject({ type: 'delta', content: 'Hi' });
    expect(events.some(event => event.type === StreamEventType.TOOL)).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
    expect(events[events.length - 1].response).toBeDefined();
    await coordinator.close();
  });

  test('handles streaming tool execution with finish_reason=tool_calls', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const processRoutes = await registry.getProcessRoutes();
    processRoutes.forEach(route => {
      route.timeoutMs = 10;
    });
    const coordinator = new LLMCoordinator(registry);

    let callCount = 0;
    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // First stream: yield tokens with tool call deltas, then finish with tool_calls
        yield {
          choices: [{
            delta: {
              content: 'Let me help',
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '' } }]
            }
          }]
        };
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"text"' } }]
            }
          }]
        };
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"hello"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      } else {
        // Second stream: follow-up after tool execution
        yield {
          choices: [{
            delta: { content: 'Done!' }
          }]
        };
      }
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: {
        ...spec.settings
      }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

    // Verify we got delta events
    const deltaEvents = events.filter(e => e.type === 'delta');
    expect(deltaEvents.length).toBeGreaterThan(0);
    expect(deltaEvents[0].content).toBe('Let me help');

    // Verify we got tool events
    const toolEvents = events.filter(e => e.type === StreamEventType.TOOL);
    expect(toolEvents.length).toBeGreaterThan(0);

    // Verify we got tool_call events
    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    expect(toolCallEvents.length).toBe(1);
    expect(toolCallEvents[0].toolCall.name).toBe('echo.text');
    expect(toolCallEvents[0].toolCall.arguments).toEqual({ text: 'hello' });

    // Verify follow-up streaming happened
    expect(deltaEvents.some(e => e.content === 'Done!')).toBe(true);

    // Verify final DONE event
    expect(events[events.length - 1].type).toBe('done');
    expect(events[events.length - 1].response.toolCalls).toHaveLength(1);

    await coordinator.close();
  });

  test('handles tool execution error in streaming mode', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    // Mock tool coordinator to throw error
    jest.spyOn(coordinator['toolCoordinator'], 'routeAndInvoke').mockRejectedValue(
      new Error('Tool execution failed')
    );

    let callCount = 0;
    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '{"text":"test"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      } else {
        yield {
          choices: [{ delta: { content: 'Error handled' } }]
        };
      }
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

    // Verify error handling happened (lines 342-354)
    expect(events[events.length - 1].type).toBe('done');

    await coordinator.close();
  });

  test('handles error creating follow-up stream', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    let callCount = 0;
    const streamProviderSpy = jest.spyOn(LLMManager.prototype, 'streamProvider');
    streamProviderSpy.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '{"text":"test"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      }
    });

    // After first stream completes, make next call throw synchronously (lines 390-393)
    const llmManager = coordinator['llmManager'];
    const originalStreamProvider = llmManager.streamProvider.bind(llmManager);
    llmManager.streamProvider = jest.fn().mockImplementationOnce(originalStreamProvider as any).mockImplementationOnce(() => {
      throw new Error('Failed to create follow-up stream');
    }) as any;

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    await expect(async () => {
      for await (const event of coordinator.runStream(specWithTools as any)) {
        // consume stream
      }
    }).rejects.toThrow('Failed to create follow-up stream');

    await coordinator.close();
  });

  test('handles error iterating follow-up stream', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    let callCount = 0;
    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '{"text":"test"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      } else {
        // Second stream: yield one chunk then throw error (lines 422-425)
        yield {
          choices: [{ delta: { content: 'Partial' } }]
        };
        throw new Error('Stream iteration failed');
      }
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    await expect(async () => {
      for await (const event of coordinator.runStream(specWithTools as any)) {
        // consume stream
      }
    }).rejects.toThrow('Stream iteration failed');

    await coordinator.close();
  });

  test('handles non-Error exception in tool execution (lines 345,351)', async () => {
    // Test the String(error) branch when error is not an Error instance
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    // Mock tool coordinator to throw a non-Error (string)
    jest.spyOn(coordinator['toolCoordinator'], 'routeAndInvoke').mockRejectedValue(
      'Non-error string thrown'  // Not an Error instance
    );

    let callCount = 0;
    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '{"text":"test"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      } else {
        yield {
          choices: [{ delta: { content: 'Handled' } }]
        };
      }
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

    // Verify error was handled (lines 345, 351 String(error) branches)
    expect(events[events.length - 1].type).toBe('done');

    await coordinator.close();
  });

  test('handles non-Error exception creating follow-up stream (line 391)', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    let callCount = 0;
    const streamProviderSpy = jest.spyOn(LLMManager.prototype, 'streamProvider');
    streamProviderSpy.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '{"text":"test"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      }
    });

    const llmManager = coordinator['llmManager'];
    const originalStreamProvider = llmManager.streamProvider.bind(llmManager);
    llmManager.streamProvider = jest.fn().mockImplementationOnce(originalStreamProvider as any).mockImplementationOnce(() => {
      throw 'String error, not Error instance';  // Non-Error exception
    }) as any;

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    await expect(async () => {
      for await (const event of coordinator.runStream(specWithTools as any)) {
        // consume stream
      }
    }).rejects.toBe('String error, not Error instance');

    await coordinator.close();
  });

  test('handles non-Error exception iterating follow-up stream (line 423)', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    let callCount = 0;
    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '{"text":"test"}' } }]
            }
          }]
        };
        yield {
          choices: [{ finish_reason: 'tool_calls' }]
        };
      } else {
        yield {
          choices: [{ delta: { content: 'Partial' } }]
        };
        throw { custom: 'object', notError: true };  // Non-Error exception
      }
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    await expect(async () => {
      for await (const event of coordinator.runStream(specWithTools as any)) {
        // consume stream
      }
    }).rejects.toEqual({ custom: 'object', notError: true });

    await coordinator.close();
  });

  test('handles missing callId in tool call events (lines 192,200)', async () => {
    // Test the || fallback branches when callId is undefined
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              // callId is undefined - tests line 192 fallback
              function: { name: 'echo.text', arguments: '{"text":"test"}' }
            }]
          }
        }]
      };
      yield {
        choices: [{ finish_reason: 'tool_calls' }]
      };
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

    expect(events[events.length - 1].type).toBe('done');

    await coordinator.close();
  });

  test('handles missing argumentsDelta (line 203)', async () => {
    // Test the || '' fallback when argumentsDelta is undefined
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      yield {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo.text', arguments: '' } }]
          }
        }]
      };
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                // argumentsDelta is undefined - tests line 203 fallback
              }
            }]
          }
        }]
      };
      yield {
        choices: [{ finish_reason: 'tool_calls' }]
      };
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

    expect(events[events.length - 1].type).toBe('done');

    await coordinator.close();
  });

  test('handles missing tool name (line 224)', async () => {
    // Test the || 'unknown' fallback chain when state.name is empty
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: {
                // name is undefined - will trigger line 224 fallback chain
                arguments: '{"text":"test"}'
              }
            }]
          }
        }]
      };
      yield {
        choices: [{ finish_reason: 'tool_calls' }]
      };
    });

    const specWithTools = {
      ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

    expect(events[events.length - 1].type).toBe('done');

    await coordinator.close();
  });

  test('aggregates reasoning from follow-up tool execution streams', async () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const coordinator = new LLMCoordinator(registry);

    jest.spyOn(coordinator['toolCoordinator'], 'routeAndInvoke').mockResolvedValue({ result: { echoed: 'hi' } });
    jest.spyOn(registry, 'getCompatModule').mockReturnValue({
      parseStreamChunk: (chunk: any) => chunk
    });

    let streamCall = 0;
    jest.spyOn(LLMManager.prototype, 'streamProvider').mockImplementation(async function* () {
      streamCall++;
      if (streamCall === 1) {
        yield {
          toolEvents: [{
            type: ToolCallEventType.TOOL_CALL_START,
            callId: 'call-1',
            name: 'echo.text'
          }]
        };
        yield {
          toolEvents: [{
            type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
            callId: 'call-1',
          argumentsDelta: '{"text":"hi"}'
        }]
      };
      yield {
        toolEvents: [{
          type: ToolCallEventType.TOOL_CALL_END,
          callId: 'call-1',
          name: 'echo.text',
          arguments: '{"text":"hi"}'
        }],
        finishedWithToolCalls: true
      };
      yield {
        reasoning: {
          text: 'Initial reasoning. ',
          metadata: { phase: 'initial' }
        }
      };
    } else {
      yield {
        text: 'Follow-up text',
        reasoning: {
          text: 'Reasoned outcome',
          metadata: { step: 'final' }
        }
      };
      yield {
        reasoning: {
          text: ' Additional detail.',
          metadata: { merged: true }
        }
      };
    }
  });

  const specWithTools = {
    ...spec,
      functionToolNames: ['echo.text'],
      settings: { ...spec.settings }
    };

    const events: any[] = [];
    for await (const event of coordinator.runStream(specWithTools as any)) {
      events.push(event);
    }

  const done = events[events.length - 1];
  expect(done.type).toBe('done');
  expect(done.response.reasoning).toEqual({
    text: 'Initial reasoning. Reasoned outcome Additional detail.',
    metadata: { phase: 'initial', step: 'final', merged: true }
  });
  expect(done.response.content[0].text).toContain('Follow-up text');

  await coordinator.close();
});
});
