import { jest } from '@jest/globals';
import { Role, ToolCallEventType } from '@/modules/kernel/index.ts';
import fs from 'fs';
import path from 'path';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
if (!unstableMockModule) {
  throw new Error('jest.unstable_mockModule is required for this test suite');
}

describe('StreamCoordinator observability', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  async function createCoordinator(options: {
    streamChunks: any[];
    parseStreamChunk: (chunk: any) => any;
    runToolLoopReturn?: any;
  }) {
    const runToolLoopMock = jest.fn(() => (async function* () {
      return options.runToolLoopReturn;
    })());

    unstableMockModule('../../../modules/tools/index.js', () => ({
      runToolLoop: runToolLoopMock
    }));

    const { StreamCoordinator } = await import('@/modules/llm/index.ts');

    const registry = {
      getProvider: jest.fn(() => ({ id: 'stub-provider', compat: 'stub-compat' })),
      getCompatModule: jest.fn(() => ({
        parseStreamChunk: options.parseStreamChunk
      }))
    } as any;

    const llmManager = {
      streamProvider: jest.fn(async function* () {
        for (const chunk of options.streamChunks) {
          yield chunk;
        }
      })
    } as any;

    const toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } })
    } as any;

    return {
      coordinator: new StreamCoordinator(registry, llmManager, toolCoordinator),
      runToolLoopMock
    };
  }

  function createObservabilityContext(captureOverrides: Partial<Record<string, any>> = {}) {
    return {
      exporter: {
        recordLLMRequest: jest.fn(),
        recordLLMResponse: jest.fn(),
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

  test('records LLM request + response events for a basic streaming call', async () => {
    const parseStreamChunk = (chunk: any) => ({
      text: chunk.text
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{ text: 'hello' }],
      parseStreamChunk
    });

    const observability = createObservabilityContext();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [{ name: 'demo-tool', description: 'demo' }];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, messages, tools, context)) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'done')).toBe(true);

    expect(observability.exporter.recordLLMRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        provider: 'stub-provider',
        model: 'stub-model',
        sessionId: 'session-456'
      })
    );

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-123',
        provider: 'stub-provider',
        model: 'stub-model',
        durationMs: expect.any(Number)
      })
    );

	    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
	    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
	    expect(typeof requestArg.timestampMs).toBe('number');
	    expect(requestArg.timestamp).toBeUndefined();
	    expect(typeof responseArg.timestampMs).toBe('number');
	    expect(responseArg.timestamp).toBeUndefined();
	    expect(typeof requestArg.generationId).toBe('string');
	    expect(requestArg.generationId).toBe(responseArg.generationId);
	  });

  test('falls back to compatibility defaults when capture fields are missing on the observability context', async () => {
    const parseStreamChunk = () => ({
      toolEvents: [
        { type: ToolCallEventType.TOOL_CALL_START, callId: 'tool-1', name: 'echo.text' },
        {
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: 'tool-1',
          argumentsDelta: '{"a":1,"api_key":"supersecret"}'
        },
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'tool-1', name: 'echo.text' }
      ],
      finishedWithToolCalls: true
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{}],
      parseStreamChunk,
      runToolLoopReturn: { content: 'follow-up' }
    });

    const observability: any = {
      exporter: {
        recordLLMRequest: jest.fn(),
        recordLLMResponse: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined)
      },
      traceId: 'trace-123',
      sessionId: 'session-456',
      metadata: { correlationId: 'corr-789' }
      // Intentionally omit captureMessages/captureToolArgs/etc.
    };

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{
      role: Role.USER,
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_result', data: { big: 'blob' } }
      ]
    }];
    const tools: any[] = [{ name: 'echo.text', description: 'echo' }];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context, { requireFinishToExecute: true })) {
      // consume
    }

    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
    expect(requestArg.messages[0].content).toHaveLength(2);

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.toolCalls).toEqual([
      { id: 'tool-1', name: 'echo.text', arguments: { a: 1, api_key: '***cret' } }
    ]);
  });

  test('omits tool call arguments in observability when captureToolArgs is disabled', async () => {
    const parseStreamChunk = () => ({
      toolEvents: [
        { type: ToolCallEventType.TOOL_CALL_START, callId: 'tool-1', name: 'echo.text' },
        {
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: 'tool-1',
          argumentsDelta: '{"a":1,"api_key":"supersecret"}'
        },
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'tool-1', name: 'echo.text' }
      ],
      finishedWithToolCalls: true
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{}],
      parseStreamChunk,
      runToolLoopReturn: { content: 'follow-up' }
    });

    const observability = createObservabilityContext({ captureToolArgs: false });

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [{ name: 'echo.text', description: 'echo' }];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context, { requireFinishToExecute: true })) {
      // consume
    }

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.toolCalls).toEqual([{ id: 'tool-1', name: 'echo.text' }]);
  });

  test('records tool call arguments in the final observability response event (minimally redacted)', async () => {
    const parseStreamChunk = () => ({
      toolEvents: [
        { type: ToolCallEventType.TOOL_CALL_START, callId: 'tool-1', name: 'echo.text' },
        {
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: 'tool-1',
          argumentsDelta: '{"a":1,"api_key":"supersecret"}'
        },
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'tool-1', name: 'echo.text' }
      ],
      finishedWithToolCalls: true
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{}],
      parseStreamChunk,
      runToolLoopReturn: { content: 'follow-up' }
    });

    const observability = createObservabilityContext();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [{ name: 'echo.text', description: 'echo' }];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context, { requireFinishToExecute: true })) {
      // consume
    }

    expect(observability.exporter.recordLLMResponse).toHaveBeenCalled();
    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.toolCalls).toEqual([
      { id: 'tool-1', name: 'echo.text', arguments: { a: 1, api_key: '***cret' } }
    ]);
  });

  test('observability toolCalls mapping handles args fallback, missing args, and metadata', async () => {
    const parseStreamChunk = () => ({
      toolEvents: [
        { type: ToolCallEventType.TOOL_CALL_START, callId: 'tool-1', name: 'echo.text' },
        { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'tool-1', argumentsDelta: '{"a":1}' },
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'tool-1', name: 'echo.text' },
        { type: ToolCallEventType.TOOL_CALL_START, callId: 'tool-2', name: 'echo.other' },
        { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'tool-2', argumentsDelta: '{"b":2}' },
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'tool-2', name: 'echo.other' }
      ],
      finishedWithToolCalls: true
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{}],
      parseStreamChunk,
      runToolLoopReturn: { content: 'follow-up' }
    });

    const observability = createObservabilityContext();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [
      { name: 'echo.text', description: 'echo' },
      { name: 'echo.other', description: 'echo' }
    ];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const event of coordinator.coordinateStream(spec, messages, tools, context, { requireFinishToExecute: true })) {
      // Mutate the emitted toolCall object; it's the same reference stored for the final observability event.
      if (event.type === 'tool_call') {
        if (event.toolCall?.id === 'tool-1') {
          delete (event.toolCall as any).arguments;
          event.toolCall.metadata = { token: 'abcd1234' };
        }

        if (event.toolCall?.id === 'tool-2') {
          delete (event.toolCall as any).arguments;
          delete (event.toolCall as any).args;
        }
      }
    }

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.toolCalls).toEqual([
      { id: 'tool-1', name: 'echo.text', arguments: { a: 1 }, metadata: { token: '***1234' } },
      { id: 'tool-2', name: 'echo.other' }
    ]);
  });

  test('when LLM_LIVE=1, stream coordinator logs observability events to the live log', async () => {
    const prevLive = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';
    try {
      await withTempCwd('stream-coordinator-observability-live-log', async () => {
        const parseStreamChunk = (chunk: any) => ({ text: chunk.text });
        const { coordinator } = await createCoordinator({
          streamChunks: [{ text: 'hello' }],
          parseStreamChunk
        });

        const observability = createObservabilityContext();
        const spec: any = {
          llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
          settings: {},
          metadata: { correlationId: 'corr-789', testFile: 'stream-coordinator-observability-live-log', testName: 'unit' }
        };

        const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
        const tools: any[] = [{ name: 'demo-tool', description: 'demo' }];

        const context: any = {
          provider: 'stub-provider',
          model: 'stub-model',
          tools,
          mcpServers: [],
          toolNameMap: new Map(),
          logger: { info: jest.fn(), warning: jest.fn() },
          metadata: spec.metadata,
          observability
        };

        for await (const _event of coordinator.coordinateStream(spec, messages, tools, context)) {
          // consume
        }

        const dateOnly = new Date().toISOString().split('T')[0];
        const logFile = path.join(
          process.cwd(),
          'tests',
          'live',
          'logs',
          `${dateOnly}-stream-coordinator-observability-live-log.log`
        );
        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('>>> OBSERVABILITY EVENT >>>');
        expect(content).toContain('Event Type: LLM_REQUEST');
        expect(content).toContain('Event Type: LLM_RESPONSE');
      });
    } finally {
      process.env.LLM_LIVE = prevLive;
    }
  });

  test('records usage + totalTokens when promptTokens is present', async () => {
    const parseStreamChunk = (chunk: any) => ({
      text: chunk.text,
      usage: { promptTokens: 10 }
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{ text: 'hello' }],
      parseStreamChunk
    });

    const observability = createObservabilityContext();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context)) {
      // consume
    }

    const callArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(callArg.usage).toEqual({
      promptTokens: 10,
      completionTokens: undefined,
      totalTokens: 10
    });
  });

  test('records usage + totalTokens when only completionTokens is present', async () => {
    const parseStreamChunk = (chunk: any) => ({
      text: chunk.text,
      usage: { completionTokens: 5 }
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{ text: 'hello' }],
      parseStreamChunk
    });

    const observability = createObservabilityContext();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context)) {
      // consume
    }

    const callArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(callArg.usage).toEqual({
      promptTokens: undefined,
      completionTokens: 5,
      totalTokens: 5
    });
  });

  test('swallows observability recording errors and logs warnings', async () => {
    const parseStreamChunk = (chunk: any) => ({
      text: chunk.text
    });

    const { coordinator } = await createCoordinator({
      streamChunks: [{ text: 'hello' }],
      parseStreamChunk
    });

    const observability = createObservabilityContext();
    (observability.exporter.recordLLMRequest as any).mockImplementation(() => {
      throw new Error('request failed');
    });
    (observability.exporter.recordLLMResponse as any).mockImplementation(() => {
      throw new Error('response failed');
    });

    const warning = jest.fn();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context)) {
      // consume
    }

    expect(warning).toHaveBeenCalledWith(
      'Failed to record observability request event',
      expect.objectContaining({ error: 'request failed' })
    );
    expect(warning).toHaveBeenCalledWith(
      'Failed to record observability response event',
      expect.objectContaining({ error: 'response failed' })
    );
  });

  test('passes runContext.observability into streaming tool loop follow-ups', async () => {
    const parseStreamChunk = () => ({
      toolEvents: [
        { type: ToolCallEventType.TOOL_CALL_START, callId: 'tool-1', name: 'echo.text' },
        { type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: 'tool-1', argumentsDelta: '{"a":1}' },
        { type: ToolCallEventType.TOOL_CALL_END, callId: 'tool-1', name: 'echo.text', arguments: '{"a":1}' }
      ],
      finishedWithToolCalls: true
    });

    const { coordinator, runToolLoopMock } = await createCoordinator({
      streamChunks: [{}],
      parseStreamChunk,
      runToolLoopReturn: { content: 'follow-up' }
    });

    const observability = createObservabilityContext();

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      metadata: { correlationId: 'corr-789' }
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools: any[] = [{ name: 'echo.text', description: 'echo' }];

    const context: any = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map(),
      logger: { info: jest.fn(), warning: jest.fn() },
      metadata: spec.metadata,
      observability
    };

    for await (const _event of coordinator.coordinateStream(spec, messages, tools, context, { requireFinishToExecute: true })) {
      // consume
    }

    expect(runToolLoopMock).toHaveBeenCalled();
    const args = runToolLoopMock.mock.calls[0][0];
    expect(args.runContext?.observability).toBe(observability);
  });
});
