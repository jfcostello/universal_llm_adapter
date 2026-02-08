import { describe, expect, jest, test } from '@jest/globals';
import { runToolLoop, __toolLoopTestUtils__ } from '@/modules/tools/index.ts';
import { ToolCallBudget } from '@/modules/tools/index.ts';
import { executeStreamToolCallsRound } from '@/modules/tools/internal/tool-loop/internal/stream-execute.ts';
import { Role, StreamEventType, ToolCallEventType } from '@/kernel/index.ts';
import { calculateUsageCost } from '@/modules/usage-cost/index.ts';

const providerManifest: any = {
  id: 'provider',
  compat: 'mock'
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drainStreamGenerator(gen: any): Promise<{ events: any[]; result: any }> {
  const events: any[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

const createLoggerStub = () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}) as any;

describe('utils/tools/runToolLoop', () => {
  test('executeStreamToolCallsRound returns early when no tool calls', async () => {
    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [],
      toolCallReasoning: undefined,
      messages: [],
      tools: [],
      toolNameMap: {},
      toolByName: new Map(),
      budget: new ToolCallBudget(0),
      toolCountdownEnabled: false,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool: async () => ({ result: null }),
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const first = await gen.next();
    expect(first.done).toBe(true);
    expect(first.value).toEqual({ terminalStopThisRound: false });
  });

  test('executeStreamToolCallsRound parallel execution streams tool results on completion, but appends tool messages in tool-call order', async () => {
    const messages: any[] = [];

    const deferred1 = createDeferred<any>();
    const deferred2 = createDeferred<any>();

    deferred2.resolve({ result: { from: 'two' } });
    setImmediate(() => deferred1.resolve({ result: { from: 'one' } }));

    const invokeTool = jest.fn(async (_toolName: string, call: any) => {
      if (call.id === 'call-1') return deferred1.promise;
      if (call.id === 'call-2') return deferred2.promise;
      throw new Error('unexpected call');
    });

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [
        { id: 'call-1', name: 'tool.one', arguments: { a: 1 }, args: { a: 1 } },
        { id: 'call-2', name: 'tool.two', arguments: { b: 2 }, args: { b: 2 } }
      ],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }, { name: 'tool.two' }] as any,
      toolNameMap: { 'tool.one': 'tool.one', 'tool.two': 'tool.two' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }], ['tool.two', { name: 'tool.two' }]]),
      budget: new ToolCallBudget(10),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const events: any[] = [];
    while (true) {
      const next = await gen.next();
      if (next.done) {
        expect(next.value).toEqual({ terminalStopThisRound: false });
        break;
      }
      events.push(next.value);
    }

    const toolResultEvents = events.filter(
      e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT
    );
    expect(toolResultEvents.map((e: any) => e.toolEvent.callId)).toEqual(['call-2', 'call-1']);

    const toolMessages = messages.filter(m => m.role === Role.TOOL);
    expect(toolMessages.map(m => m.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  test('executeStreamToolCallsRound parallel execution does not emit TOOL_RESULT for budget-exhausted calls', async () => {
    const messages: any[] = [];

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [
        { id: 'call-1', name: 'tool.one', arguments: {}, args: {} },
        { id: 'call-2', name: 'tool.two', arguments: {}, args: {} }
      ],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }, { name: 'tool.two' }] as any,
      toolNameMap: { 'tool.one': 'tool.one', 'tool.two': 'tool.two' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }], ['tool.two', { name: 'tool.two' }]]),
      budget: new ToolCallBudget(1),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const events: any[] = [];
    // Drain generator
    while (true) {
      const next = await gen.next();
      if (next.done) {
        expect(next.value).toEqual({ terminalStopThisRound: false });
        break;
      }
      events.push(next.value);
    }

    const toolResultEvents = events.filter(
      e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT
    );
    expect(toolResultEvents.map((e: any) => e.toolEvent.callId)).toEqual(['call-1']);

    const toolMessages = messages.filter(m => m.role === Role.TOOL);
    expect(toolMessages.map(m => m.toolCallId)).toEqual(['call-1', 'call-2']);

    const exhaustedMessage = toolMessages.find(m => m.toolCallId === 'call-2');
    expect(exhaustedMessage.content?.some((c: any) => c.type === 'tool_result' && c.result?.error === 'tool_call_budget_exhausted')).toBe(true);
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  test('executeStreamToolCallsRound parallel execution covers tool name mapping fallbacks and truncation paths', async () => {
    const messages: any[] = [];

    const invokeTool = jest.fn().mockResolvedValue('ok');

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [
        // directMatch branch
        { id: 'call-1', name: 'direct.name', arguments: { a: 1 }, args: { a: 1 } },
        // sanitizedMatch branch (toolNameMap has only sanitized key)
        { id: 'call-2', name: 'needs.sanitize', arguments: { b: 2 } },
        // fallback-to-call.name branch (no mapping)
        { id: 'call-3', name: 'no.map', args: { c: 3 } },
        // unknown_tool branch (name missing and no mapping)
        { id: 'call-4' } as any
      ],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'direct.name' }, { name: 'needs.sanitize' }, { name: 'no.map' }] as any,
      toolNameMap: {
        'direct.name': 'direct.name',
        needs_sanitize: 'needs.sanitize'
      },
      toolByName: new Map([
        ['direct.name', { name: 'direct.name' }],
        ['needs.sanitize', { name: 'needs.sanitize' }],
        ['no.map', { name: 'no.map' }]
      ]),
      budget: new ToolCallBudget(10),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: 1,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: false });

    const invokedTools = invokeTool.mock.calls.map(call => call[0]);
    expect(invokedTools).toEqual(['direct.name', 'needs.sanitize', 'no.map', 'unknown_tool']);
  });

  test('executeStreamToolCallsRound parallel execution skips all tool invocations when budget exhausted at start', async () => {
    const messages: any[] = [];
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [
        { id: 'call-1', name: 'tool.one', arguments: {}, args: {} },
        { id: 'call-2', name: 'tool.two', arguments: {}, args: {} }
      ],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }, { name: 'tool.two' }] as any,
      toolNameMap: { 'tool.one': 'tool.one', 'tool.two': 'tool.two' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }], ['tool.two', { name: 'tool.two' }]]),
      budget: new ToolCallBudget(0),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { events, result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: false });
    expect(events.length).toBe(0);
    expect(invokeTool).toHaveBeenCalledTimes(0);

    const toolMessages = messages.filter(m => m.role === Role.TOOL);
    expect(toolMessages.length).toBe(2);
    expect(toolMessages.every((m: any) => m.content?.some((c: any) => c.type === 'tool_result' && c.result?.error === 'tool_call_budget_exhausted'))).toBe(true);
  });

  test('executeStreamToolCallsRound parallel execution covers consume=false branch without invoking tools', async () => {
    const messages: any[] = [];
    const logger = createLoggerStub();
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool.one', arguments: {}, args: {} }],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }] as any,
      toolNameMap: { 'tool.one': 'tool.one' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }]]),
      budget: new ToolCallBudget(0.5),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger,
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { events, result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: false });
    expect(events.length).toBe(0);
    expect(invokeTool).toHaveBeenCalledTimes(0);
    expect(logger.info).toHaveBeenCalledWith(
      'Tool budget consumption blocked invocation',
      expect.objectContaining({ toolName: 'tool.one', callId: 'call-1' })
    );
  });

  test('executeStreamToolCallsRound parallel execution records terminal stop when tool result override is terminal', async () => {
    const messages: any[] = [];

    const invokeTool = jest.fn().mockResolvedValue({
      tool_type_response_override_terminal: true,
      result: 'terminal'
    });

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool.one', arguments: {}, args: {} }],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }] as any,
      toolNameMap: { 'tool.one': 'tool.one' },
      toolByName: new Map([['tool.one', { name: 'tool.one', terminal: false }]]),
      budget: new ToolCallBudget(2),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: 10,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: true });
  });

  test('executeStreamToolCallsRound parallel execution honors call-arg terminal override when tool result override is absent', async () => {
    const messages: any[] = [];

    const invokeTool = jest.fn().mockResolvedValue('ok');

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool.one', arguments: { terminal: true }, args: { terminal: true } }],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }] as any,
      toolNameMap: { 'tool.one': 'tool.one' },
      toolByName: new Map([
        [
          'tool.one',
          {
            name: 'tool.one',
            terminal: false,
            toolCallTerminalFlag: { field: 'terminal' }
          }
        ]
      ]),
      budget: new ToolCallBudget(2),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: true });
  });

  test('executeStreamToolCallsRound parallel execution covers error handling (Error and non-Error throws)', async () => {
    const messages: any[] = [];
    const invokeTool = jest.fn(async (_toolName: string, call: any) => {
      if (call.id === 'call-1') throw new Error('boom');
      throw 'bang';
    });

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [
        { id: 'call-1', name: 'tool.one', arguments: {}, args: {} },
        { id: 'call-2', name: 'tool.two', arguments: {}, args: {} }
      ],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }, { name: 'tool.two' }] as any,
      toolNameMap: { 'tool.one': 'tool.one', 'tool.two': 'tool.two' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }], ['tool.two', { name: 'tool.two' }]]),
      budget: new ToolCallBudget(10),
      toolCountdownEnabled: false,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger: createLoggerStub(),
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { events, result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: false });

    const toolResultEvents = events.filter(
      e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT
    );
    expect(toolResultEvents.length).toBe(2);
    for (const ev of toolResultEvents) {
      const payload = JSON.parse(String(ev.toolEvent.arguments ?? 'null'));
      expect(payload?.error).toBe('tool_execution_failed');
    }
  });

  test('executeStreamToolCallsRound parallel execution covers countdown progress fields when budget is finite', async () => {
    const messages: any[] = [];
    const logger = createLoggerStub();
    const invokeTool = jest.fn().mockResolvedValue('ok');

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool.one', arguments: {}, args: {} }],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }] as any,
      toolNameMap: { 'tool.one': 'tool.one' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }]]),
      budget: new ToolCallBudget(2),
      toolCountdownEnabled: true,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger,
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: false });
    expect(logger.info).toHaveBeenCalledWith(
      'Invoking tool',
      expect.objectContaining({ toolCallProgress: expect.stringContaining('Tool call') })
    );
  });

  test('executeStreamToolCallsRound parallel execution skips progress fields when budget is null even if countdown is enabled', async () => {
    const messages: any[] = [];
    const logger = createLoggerStub();
    const invokeTool = jest.fn().mockResolvedValue('ok');

    const gen = executeStreamToolCallsRound({
      toolCallsToExecute: [{ id: 'call-1', name: 'tool.one', arguments: {}, args: {} }],
      toolCallReasoning: undefined,
      messages,
      tools: [{ name: 'tool.one' }] as any,
      toolNameMap: { 'tool.one': 'tool.one' },
      toolByName: new Map([['tool.one', { name: 'tool.one' }]]),
      budget: new ToolCallBudget(null),
      toolCountdownEnabled: true,
      parallelExecution: true,
      maxResultLength: null,
      providerManifest,
      model: 'model',
      metadata: undefined,
      logger,
      invokeTool,
      calledToolNames: new Set(),
      preserveToolResults: 'all',
      preserveReasoning: 'all'
    } as any);

    const { result } = await drainStreamGenerator(gen);
    expect(result).toEqual({ terminalStopThisRound: false });
    expect(logger.info).toHaveBeenCalledWith('Invoking tool', expect.not.objectContaining({ toolCallProgress: expect.any(String) }));
  });

  test('non-stream loop handles string runtime flags and records tool results', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { value: 42 } });

    const messages = [{
      role: Role.USER,
      content: [{ type: 'text', text: 'hello' }]
    }];

    const initialResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'example_tool',
          arguments: { answer: true }
        }
      ]
    } as any;

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages,
      tools: [{ name: 'example_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'false',
        toolFinalPromptEnabled: 'false',
        maxToolIterations: '2',
        preserveToolResults: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledWith(
      'example_tool',
      expect.objectContaining({ id: 'call-1' }),
      expect.objectContaining({ provider: 'provider' })
    );
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.toolCalls?.[0].name).toBe('example_tool');
    expect(result.raw?.toolResults?.[0].result).toEqual({ value: 42 });
  });

  test('non-stream loop relaxes required toolChoice after tool execution', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'final' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const initialResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'example_tool',
          arguments: {}
        }
      ]
    } as any;

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: { type: 'required', allowed: ['example_tool'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalled();
    expect(callProvider).toHaveBeenCalledTimes(1);
    // toolChoice arg in callProvider signature should be relaxed to auto for follow-up
    expect(callProvider.mock.calls[0][5]).toBe('auto');
  });

  test('non-stream loop keeps ToolChoiceRequired until all allowed tools are called', async () => {
    const callProvider = jest
      .fn()
      .mockResolvedValueOnce({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-2', name: 'tool_b', arguments: {} }]
      })
      .mockResolvedValueOnce({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const initialResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }]
    } as any;

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { tool_a: 'tool_a', tool_b: 'tool_b' },
      metadata: {},
      initialResponse,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(callProvider.mock.calls[0][5]).toMatchObject({ type: 'single', name: 'tool_b' });
    expect(callProvider.mock.calls[1][5]).toBe('auto');
  });

  test('non-stream loop keeps ToolChoiceRequired when multiple allowed tools remain', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [{ id: 'call-2', name: 'tool_b', arguments: {} }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const initialResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }]
    } as any;

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }, { name: 'tool_c' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b', 'tool_c'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { tool_a: 'tool_a', tool_b: 'tool_b', tool_c: 'tool_c' },
      metadata: {},
      initialResponse,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(callProvider.mock.calls[0][5]).toMatchObject({ type: 'required', allowed: ['tool_a', 'tool_b', 'tool_c'] });
  });

  test('non-stream loop relaxes ToolChoiceRequired when allow-list is empty or invalid', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'final' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }] as any,
      toolChoice: { type: 'required', allowed: null } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalled();
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(callProvider.mock.calls[0][5]).toBe('auto');
  });

  test('non-stream loop retries when required toolChoice is ignored', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;

      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
      }

      if (callNumber === 1) {
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { value: 1 } }]
        };
      }

      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: { type: 'required', allowed: ['example_tool'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'should-not-be-inserted' }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(callProvider.mock.calls[0][5]).toMatchObject({ type: 'required', allowed: ['example_tool'] });
    expect(callProvider.mock.calls[1][5]).toBe('auto');

    expect(firstRetryUserText).toContain('You MUST call the required tool now.');

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(Array.isArray((result as any).toolCalls)).toBe(true);
    expect((result as any).toolCalls?.length).toBeGreaterThanOrEqual(1);
  });

  test('non-stream loop retries when a required follow-up tool call is ignored', async () => {
    let reminderText = '';
    let callNumber = 0;

    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      const messages = args[3] as any[];
      if (callNumber === 2) {
        reminderText = String(messages.at(-1)?.content?.[0]?.text ?? '');
      }

      if (callNumber === 1) {
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'ignored follow-up' }]
        };
      }

      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-2', name: 'example_tool', arguments: {} }]
      };
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: { type: 'single', name: 'example_tool' } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(callProvider.mock.calls[0][5]).toMatchObject({ type: 'single', name: 'example_tool' });
    expect(callProvider.mock.calls[1][5]).toMatchObject({ type: 'single', name: 'example_tool' });
    expect(reminderText).toContain('You MUST call the required tool now.');

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect((result as any).raw?.toolResults?.length).toBeGreaterThanOrEqual(2);
  });

  test('non-stream retry reminder omits tool name for toolChoice="required"', async () => {
    let reminderText = '';
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      const messages = args[3] as any[];
      reminderText = String(messages.at(-1)?.content?.[0]?.text ?? '');

      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: {} }]
      };
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'required' as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 1, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'ignored initial response' }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(reminderText).toContain('You MUST call the required tool now.');
    expect(reminderText).not.toContain('Call tool:');
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect((result as any).raw?.toolResults?.length).toBeGreaterThanOrEqual(1);
  });

  test('non-stream retry reminder uses api tool name when no display mapping exists', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { value: 1 } }]
        };
      }
      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = { callProvider, streamProvider: jest.fn() };
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: { type: 'required', allowed: ['example_tool'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: {},
      metadata: {},
      initialResponse: { provider: 'provider', model: 'model', role: Role.ASSISTANT, content: [] } as any,
      invokeTool
    });

    expect(firstRetryUserText).toContain('Call tool: example_tool');
  });

  test('non-stream retry reminder includes mapped tool name when display mapping differs', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { value: 1 } }]
        };
      }
      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = { callProvider, streamProvider: jest.fn() };
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: { type: 'required', allowed: ['example_tool'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'tool.original' },
      metadata: {},
      initialResponse: { provider: 'provider', model: 'model', role: Role.ASSISTANT, content: [] } as any,
      invokeTool
    });

    expect(firstRetryUserText).toContain('Call tool: tool.original (tool name: example_tool)');
  });

  test('non-stream retry reminder lists allowed tools when ToolChoiceRequired contains multiple tools', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool_a', arguments: { value: 1 } }]
        };
      }
      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = { callProvider, streamProvider: jest.fn() };
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }, { name: 'tool_c' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b', 'tool_c'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { tool_a: 'tool.a', tool_b: 'tool.b' },
      metadata: {},
      initialResponse: { provider: 'provider', model: 'model', role: Role.ASSISTANT, content: [] } as any,
      invokeTool
    });

    expect(firstRetryUserText).toContain('Allowed tools: tool.a, tool.b, tool_c');
  });

  test('non-stream retry reminder ignores non-array allow list defensively', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: { value: 1 } }]
        };
      }
      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = { callProvider, streamProvider: jest.fn() };
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: { type: 'required', allowed: 'not-an-array' } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: {},
      metadata: {},
      initialResponse: { provider: 'provider', model: 'model', role: Role.ASSISTANT, content: [] } as any,
      invokeTool
    });

    expect(firstRetryUserText).toContain('You MUST call the required tool now.');
    expect(firstRetryUserText).not.toContain('Call tool:');
    expect(firstRetryUserText).not.toContain('Allowed tools:');
  });

  test('non-stream retry reminder supports ToolChoiceSingle', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool_b', arguments: { value: 1 } }]
        };
      }
      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = { callProvider, streamProvider: jest.fn() };
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'tool_b' }] as any,
      toolChoice: { type: 'single', name: 'tool_b' } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { tool_b: 'tool.original' },
      metadata: {},
      initialResponse: { provider: 'provider', model: 'model', role: Role.ASSISTANT, content: [] } as any,
      invokeTool
    });

    expect(firstRetryUserText).toContain('Call tool: tool.original (tool name: tool_b)');
  });

  test('non-stream retry reminder uses api tool name for ToolChoiceSingle when no display mapping exists', async () => {
    let firstRetryUserText = '';
    let callNumber = 0;
    const callProvider = jest.fn().mockImplementation(async (...args: any[]) => {
      callNumber += 1;
      if (callNumber === 1) {
        const messages = args[3] as any[];
        firstRetryUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        return {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool_b', arguments: { value: 1 } }]
        };
      }
      return {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      };
    });

    const llmManager: any = { callProvider, streamProvider: jest.fn() };
    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'tool_b' }] as any,
      toolChoice: { type: 'single', name: 'tool_b' } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: {},
      metadata: {},
      initialResponse: { provider: 'provider', model: 'model', role: Role.ASSISTANT, content: [] } as any,
      invokeTool
    });

    expect(firstRetryUserText).toContain('Call tool: tool_b');
    expect(firstRetryUserText).not.toContain('(tool name:');
  });

  test('non-stream loop relaxes toolChoice="required" after tool execution', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'final' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const initialResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'example_tool',
          arguments: {}
        }
      ]
    } as any;

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }],
      toolChoice: 'required' as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalled();
    expect(callProvider).toHaveBeenCalledTimes(1);
    // toolChoice arg in callProvider signature should be relaxed to auto for follow-up
    expect(callProvider.mock.calls[0][5]).toBe('auto');
  });

  test('non-stream loop stops without follow-up when tool definition is terminal', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'should-not-run' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const messages = [{
      role: Role.USER,
      content: [{ type: 'text', text: 'hello' }]
    }];

    const initialResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'example.tool',
          arguments: {}
        }
      ]
    } as any;

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages,
      tools: [{ name: 'example_tool', terminal: true }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        maxToolIterations: 2,
        toolFinalPromptEnabled: false
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(callProvider).toHaveBeenCalledTimes(0);
    expect(result.finishReason).toBe('tool_stop');
    expect(result.raw?.toolResults?.[0].result).toEqual({ ok: true });
  });

  test('non-stream loop stops on terminal tool definition even when tool invocation fails', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'should-not-run' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockRejectedValue(new Error('boom'));

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool', terminal: true }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: true } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example_tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(0);
    expect(result.finishReason).toBe('tool_stop');
    expect(result.raw?.toolResults?.[0].result).toMatchObject({ error: 'tool_execution_failed' });
  });

  test('non-stream loop stops without follow-up when tool result override is terminal (top-level)', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'should-not-run' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({
      result: { ok: true },
      tool_type_response_override_terminal: true
    });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(0);
    expect(result.finishReason).toBe('tool_stop');
  });

  test('non-stream loop stops without follow-up when tool result override is terminal (nested in result)', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'should-not-run' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({
      result: { ok: true, tool_type_response_override_terminal: true }
    });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(0);
    expect(result.finishReason).toBe('tool_stop');
  });

  test('non-stream loop prefers top-level override over nested override', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({
      result: { ok: true, tool_type_response_override_terminal: true },
      tool_type_response_override_terminal: false
    });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
  });

  test('non-stream loop continues when override is false even if tool definition is terminal', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({
      result: { ok: true },
      tool_type_response_override_terminal: false
    });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool', terminal: true }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
  });

  test('non-stream loop ignores non-boolean terminal overrides (strict boolean)', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({
      result: { ok: true },
      // Should be ignored
      tool_type_response_override_terminal: 'true'
    });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'example_tool' }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: {} }]
      } as any,
      invokeTool
    });

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
  });

  test('non-stream loop stops without follow-up when call-arg terminal override is true', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'should-not-run' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'example_tool',
          terminal: false,
          toolCallTerminalFlag: { field: 'terminal' }
        }
      ] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: { terminal: true } }]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokedCall = invokeTool.mock.calls[0]?.[1];
    expect(invokedCall?.arguments).toEqual({});
    expect(callProvider).toHaveBeenCalledTimes(0);
    expect(result.finishReason).toBe('tool_stop');

    const returnedToolCalls = Array.isArray((result as any).toolCalls) ? (result as any).toolCalls : [];
    expect(returnedToolCalls[0]?.arguments?.terminal).toBe(true);
  });

  test('non-stream loop stops on call-arg terminal override even when tool invocation fails', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'should-not-run' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockRejectedValue(new Error('boom'));

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'example_tool',
          terminal: false,
          toolCallTerminalFlag: { field: 'terminal' }
        }
      ] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: { terminal: true } }]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokedCall = invokeTool.mock.calls[0]?.[1];
    expect(invokedCall?.arguments).toEqual({});
    expect(callProvider).toHaveBeenCalledTimes(0);
    expect(result.finishReason).toBe('tool_stop');
  });

  test('non-stream loop ignores missing call-arg terminal flag (no override)', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const originalToolCall = { id: 'call-1', name: 'example.tool', arguments: {} };

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'example_tool',
          terminal: false,
          toolCallTerminalFlag: { field: 'terminal' }
        }
      ] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [originalToolCall]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool.mock.calls[0]?.[1]).toBe(originalToolCall);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
  });

  test('non-stream loop tolerates non-object arguments for call-arg terminal flag lookup', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const originalToolCall = { id: 'call-1', name: 'example.tool', arguments: null };

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'example_tool',
          terminal: false,
          toolCallTerminalFlag: { field: 'terminal' }
        }
      ] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [originalToolCall]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool.mock.calls[0]?.[1]).toBe(originalToolCall);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
  });

  test('non-stream loop continues when call-arg terminal override is false even if tool definition is terminal', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'example_tool',
          terminal: true,
          toolCallTerminalFlag: { field: 'terminal' }
        }
      ] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: { terminal: false } }]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokedCall = invokeTool.mock.calls[0]?.[1];
    expect(invokedCall?.arguments).toEqual({});
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');

    const returnedToolCalls = Array.isArray((result as any).toolCalls) ? (result as any).toolCalls : [];
    expect(returnedToolCalls[0]?.arguments?.terminal).toBe(false);
  });

  test('non-stream loop ignores non-boolean call-arg terminal overrides (strict boolean)', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'example_tool',
          toolCallTerminalFlag: { field: 'terminal' }
        }
      ] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2, toolFinalPromptEnabled: false } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { example_tool: 'example.tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'example.tool', arguments: { terminal: 'true' } }]
      } as any,
      invokeTool
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokedCall = invokeTool.mock.calls[0]?.[1];
    expect(invokedCall?.arguments).toEqual({});
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
  });

  test('stream loop stops without follow-up stream when terminal override is true', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { choices: [{ delta: { content: 'should-not-run' } }] };
      })
    };

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'demo_tool' }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { demo_tool: 'demo_tool' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'demo_tool', arguments: {} }],
      invokeTool: jest.fn().mockResolvedValue({
        result: { ok: true },
        tool_type_response_override_terminal: true
      })
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(events.filter(e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)).toHaveLength(1);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(0);
    expect(finalResult).toEqual({ finishReason: 'tool_stop' });
  });

  test('stream loop stops without follow-up stream when call-arg terminal override is true', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { choices: [{ delta: { content: 'should-not-run' } }] };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'demo_tool', terminal: false, toolCallTerminalFlag: { field: 'terminal' } }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 2 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { demo_tool: 'demo_tool' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'demo_tool', arguments: { terminal: true } }],
      invokeTool
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokedCall = invokeTool.mock.calls[0]?.[1];
    expect(invokedCall?.arguments).toEqual({});

    expect(events.filter(e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)).toHaveLength(1);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(0);
    expect(finalResult).toEqual({ finishReason: 'tool_stop' });
  });

  test('stream loop executes all tool calls in a round then stops when any call is terminal', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { choices: [{ delta: { content: 'should-not-run' } }] };
      })
    };

    const invokeTool = jest
      .fn()
      .mockResolvedValueOnce({
        result: { ok: 'alpha' },
        tool_type_response_override_terminal: true
      })
      .mockResolvedValueOnce({
        result: { ok: 'beta' }
      });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'alpha_tool' }, { name: 'beta_tool' }] as any,
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: {},
      metadata: {},
      initialToolCalls: [
        { id: 'call-1', name: 'alpha_tool', arguments: {} },
        { id: 'call-2', name: 'beta_tool', arguments: {} }
      ],
      invokeTool
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(
      events.filter(e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)
    ).toHaveLength(2);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(0);
    expect(finalResult).toEqual({ finishReason: 'tool_stop' });
  });

  test('stream loop emits tool result and honors countdown progress fields', async () => {
    const streamChunks = [
      { choices: [{ delta: { content: 'token-1' } }] },
      { choices: [{ delta: { content: 'token-2' } }] }
    ];

    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      })
    };

    const logger = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;

    const events: any[] = [];
    const generator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool.original' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: true,
        maxToolIterations: 1,
        preserveToolResults: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger,
      toolNameMap: {
        'tool_sanitized': 'tool.original'
      },
      metadata: {},
      initialToolCalls: [
        {
          id: 'call-9',
          name: 'tool.sanitized',
          arguments: { input: 'value' }
        }
      ],
      invokeTool: jest.fn().mockResolvedValue('string-result')
    });

    for await (const event of generator) {
      events.push(event);
    }

    expect(events.filter(e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)).toHaveLength(1);
    expect(events.filter(e => e.type === StreamEventType.DELTA)).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Invoking tool',
      expect.objectContaining({ toolCallProgress: expect.stringContaining('Tool call') })
    );
  });

  test('stream loop keeps ToolChoiceRequired until all allowed tools are called', async () => {
    const streamProviderCalls: any[] = [];

    const llmManager: any = {
      streamProvider: jest.fn(async function* (...args: any[]) {
        streamProviderCalls.push(args);

        if (streamProviderCalls.length === 1) {
          yield {
            toolEvents: [{
              type: ToolCallEventType.TOOL_CALL_END,
              callId: 'call-2',
              name: 'tool_b',
              arguments: '{}'
            }]
          };
          return;
        }

        yield { text: 'final' };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => chunk
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { tool_a: 'tool_a', tool_b: 'tool_b' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      invokeTool
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    expect(streamProviderCalls[0][5]).toMatchObject({ type: 'single', name: 'tool_b' });
    expect(streamProviderCalls[1][5]).toBe('auto');
    expect(finalResult?.content).toBe('final');
  });

  test('stream loop retries when a required follow-up tool call is ignored', async () => {
    const streamProviderCalls: any[] = [];

    const llmManager: any = {
      streamProvider: jest.fn(async function* (...args: any[]) {
        streamProviderCalls.push(args);

        // 1) First attempt: model ignores tool_choice and emits text.
        if (streamProviderCalls.length === 1) {
          yield { text: 'oops' };
          return;
        }

        // 2) Second attempt: tool call is finally emitted.
        if (streamProviderCalls.length === 2) {
          yield {
            toolEvents: [{
              type: ToolCallEventType.TOOL_CALL_END,
              callId: 'call-2',
              name: 'tool_b',
              arguments: '{}'
            }]
          };
          return;
        }

        // 3) Final attempt: assistant produces final text.
        yield { text: 'final' };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => chunk
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { tool_a: 'tool_a', tool_b: 'tool_b' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      invokeTool
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
    expect(streamProviderCalls[0][5]).toMatchObject({ type: 'single', name: 'tool_b' });
    expect(streamProviderCalls[1][5]).toMatchObject({ type: 'single', name: 'tool_b' });
    expect(streamProviderCalls[2][5]).toBe('auto');

    const deltas = events.filter(e => e.type === StreamEventType.DELTA).map(e => e.content).join('');
    expect(deltas).toBe('final');
    expect(finalResult?.content).toBe('final');
  });

  test('stream loop retry reminder uses api tool name when no display mapping exists', async () => {
    const streamProviderCalls: any[] = [];

    const llmManager: any = {
      streamProvider: jest.fn(async function* (...args: any[]) {
        streamProviderCalls.push(args);

        if (streamProviderCalls.length === 1) {
          yield { text: 'oops' };
          return;
        }

        if (streamProviderCalls.length === 2) {
          const messages = args[3] as any[];
          const lastUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
          expect(lastUserText).toContain('Call tool: tool_b');

          yield {
            toolEvents: [{
              type: ToolCallEventType.TOOL_CALL_END,
              callId: 'call-2',
              name: 'tool_b',
              arguments: '{}'
            }]
          };
          return;
        }

        yield { text: 'final' };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => chunk
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: {},
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      invokeTool
    });

    const events: any[] = [];
    while (!(await iterator.next()).done) {
      // drain
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
    expect(events.length).toBe(0);
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  test('stream loop retry reminder includes mapped single tool name when display mapping differs', async () => {
    const streamProviderCalls: any[] = [];

    const llmManager: any = {
      streamProvider: jest.fn(async function* (...args: any[]) {
        streamProviderCalls.push(args);

        if (streamProviderCalls.length === 1) {
          yield { text: 'oops' };
          return;
        }

        if (streamProviderCalls.length === 2) {
          const messages = args[3] as any[];
          const lastUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
          expect(lastUserText).toContain('Call tool: tool.original (tool name: tool_b)');

          yield {
            toolEvents: [{
              type: ToolCallEventType.TOOL_CALL_END,
              callId: 'call-2',
              name: 'tool_b',
              arguments: '{}'
            }]
          };
          return;
        }

        yield { text: 'final' };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => chunk
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { tool_b: 'tool.original' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      invokeTool
    });

    while (!(await iterator.next()).done) {
      // drain
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  test('stream loop retry reminder lists allowed tools when ToolChoiceRequired remains', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* (...args: any[]) {
        const callNumber = llmManager.streamProvider.mock.calls.length;

        if (callNumber === 1) {
          yield { text: 'oops' };
          return;
        }

        if (callNumber === 2) {
          const messages = args[3] as any[];
          const lastUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
          expect(lastUserText).toContain('Allowed tools: tool.a, tool.b, tool_c');

          yield {
            toolEvents: [
              { type: ToolCallEventType.TOOL_CALL_END, callId: 'call-2', name: 'tool_b', arguments: '{}' },
              { type: ToolCallEventType.TOOL_CALL_END, callId: 'call-3', name: 'tool_c', arguments: '{}' }
            ]
          };
          return;
        }

        yield { text: 'final' };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => chunk
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }, { name: 'tool_c' }] as any,
      toolChoice: { type: 'required', allowed: ['tool_a', 'tool_b', 'tool_c'] } as any,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { tool_a: 'tool.a', tool_b: 'tool.b' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      invokeTool
    });

    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
    }

    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(llmManager.streamProvider).toHaveBeenCalledTimes(3);
    expect(finalResult?.content).toBe('final');
  });

  test('stream loop retry reminder ignores non-array allowed field defensively', async () => {
    const toolChoice: any = { type: 'required', allowed: ['tool_a', 'tool_b', 'tool_c'] };

    const llmManager: any = {
      streamProvider: jest.fn(async function* (...args: any[]) {
        const callNumber = llmManager.streamProvider.mock.calls.length;

        if (callNumber === 1) {
          expect(args[5]).toMatchObject({ type: 'required' });
          yield { text: 'oops' };
          toolChoice.allowed = 'not-an-array';
          return;
        }

        const messages = args[3] as any[];
        const lastUserText = String(messages.at(-1)?.content?.[0]?.text ?? '');
        expect(lastUserText).toContain('You MUST call the required tool now.');
        expect(lastUserText).not.toContain('Allowed tools:');

        yield { text: 'final' };
      })
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => chunk
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }, { name: 'tool_c' }] as any,
      toolChoice,
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 3 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { tool_a: 'tool.a', tool_b: 'tool.b' },
      metadata: {},
      initialToolCalls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      invokeTool
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(llmManager.streamProvider).toHaveBeenCalledTimes(2);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    const deltas = events.filter(e => e.type === StreamEventType.DELTA).map(e => e.content).join('');
    expect(deltas).toBe('final');
    expect(finalResult?.content).toBe('final');
  });

  test('normalizeFlag fallbacks retain defaults for unexpected values', async () => {
    const originalConsume = ToolCallBudget.prototype.consume;
    const consumeSpy = jest
      .spyOn(ToolCallBudget.prototype, 'consume')
      .mockImplementation(function (this: ToolCallBudget, amount = 1) {
        this.maxCalls = null;
        return originalConsume.call(this, amount);
      });

    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'done' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    try {
      await runToolLoop({
        mode: 'nonstream',
        llmManager,
        registry: {} as any,
        messages: [{ role: Role.USER, content: [] }],
        tools: [{ name: 'demo_tool' }],
        providerManifest,
        model: 'model',
        runtime: {
          toolCountdownEnabled: 'maybe' as any,
          toolFinalPromptEnabled: {} as any,
          maxToolIterations: 1
        } as any,
        providerSettings: {},
        providerExtras: {},
        logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
        runContext: {},
        toolNameMap: { demo_tool: 'demo_tool' },
        metadata: {},
        initialResponse: {
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            {
              id: 'x',
              name: 'demo_tool',
              arguments: {}
            }
          ]
        } as any,
        invokeTool: jest.fn().mockResolvedValue({ result: 'ok' })
      });
    } finally {
      consumeSpy.mockRestore();
    }

    expect(callProvider).toHaveBeenCalled();
  });

  test('stream loop skips countdown details when maxCalls is null', async () => {
    const originalConsume = ToolCallBudget.prototype.consume;
    const consumeSpy = jest
      .spyOn(ToolCallBudget.prototype, 'consume')
      .mockImplementation(function (this: ToolCallBudget, amount = 1) {
        this.maxCalls = null;
        return originalConsume.call(this, amount);
      });

    try {
      const llmManager: any = {
        streamProvider: jest.fn(async function* () {
          yield { choices: [{ delta: { content: 'done' } }] };
        })
      };

      const events: any[] = [];
      const generator = runToolLoop({
        mode: 'stream',
        llmManager,
        registry: {
          getCompatModule: () => ({
            parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
          })
        } as any,
        messages: [{ role: Role.USER, content: [] }],
        tools: [{ name: 'demo-tool' }],
        providerManifest,
        model: 'model',
        runtime: {
          toolCountdownEnabled: true,
          maxToolIterations: 1
        } as any,
        providerSettings: {},
        providerExtras: {},
        logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
        toolNameMap: { demo_tool: 'demo-tool' },
        metadata: {},
        initialToolCalls: [
          {
            id: 'call-5',
            name: 'demo_tool',
            arguments: {}
          }
        ],
        invokeTool: jest.fn().mockResolvedValue({ result: null })
      });

      for await (const event of generator) {
        events.push(event);
      }

      expect(events.at(-1)?.type).toBe(StreamEventType.DELTA);
    } finally {
      consumeSpy.mockRestore();
    }
  });

  test('stream loop surfaces usage and reasoning metadata from follow-up chunks', async () => {
    const primaryChunks = [
      { choices: [{ delta: { content: 'primary' } }] }
    ];

    const followUpChunks = [
      {
        choices: [
          {
            delta: { content: 'followup', reasoning: { text: 'Final step.' } },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
          completion_tokens_details: { reasoning_tokens: 1 }
        }
      }
    ];

    const llmManager: any = {
      streamProvider: jest
        .fn(async function* () {
          for (const chunk of primaryChunks) {
            yield chunk;
          }
        })
        .mockImplementationOnce(async function* () {
          for (const chunk of followUpChunks) {
            yield chunk;
          }
        })
    };

    const compat = {
      parseStreamChunk: (chunk: any) => ({
        text: chunk.choices?.[0]?.delta?.content,
        usage: chunk.usage
          ? {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens
            }
          : undefined,
        reasoning: chunk.choices?.[0]?.delta?.reasoning
      })
    };

    const registry: any = {
      getCompatModule: () => compat
    };

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'demo-tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: false,
        maxToolIterations: 1,
        preserveToolResults: 1,
        preserveReasoning: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { demo_tool: 'demo-tool' },
      metadata: {},
      initialToolCalls: [
        { id: 'call-1', name: 'demo_tool', arguments: {} }
      ],
      invokeTool: jest.fn().mockResolvedValue({ result: 'payload' })
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(events.some(event => event.type === StreamEventType.TOKEN)).toBe(true);
    expect(finalResult).toEqual({
      content: 'followup',
      usage: {
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
        reasoningTokens: 1
      },
      reasoning: { text: 'Final step.' }
    });
  });

  test('stream loop returns undefined metadata when follow-up stream yields no extras', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        // follow-up stream yields no chunks
      })
    };

    const registry: any = {
      getCompatModule: () => ({
        parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
      })
    };

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'demo-tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: false,
        maxToolIterations: 1,
        preserveToolResults: 1,
        preserveReasoning: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { demo_tool: 'demo-tool' },
      metadata: {},
      initialToolCalls: [
        { id: 'call-1', name: 'demo_tool', arguments: {} }
      ],
      invokeTool: jest.fn().mockResolvedValue({ result: 'payload' })
    });

    let finalResult: any;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
    }

    expect(finalResult).toBeUndefined();
  });

  test('non-stream loop handles exhausted budget without invoking tools', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'terminal' }]
    });

    await runToolLoop({
      mode: 'nonstream',
      llmManager: { callProvider } as any,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'exhausted' }],
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: true,
        maxToolIterations: 0,
        toolFinalPromptEnabled: false
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: undefined,
      toolNameMap: { exhausted: 'exhausted' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'budget',
            name: 'exhausted',
            arguments: {}
          }
        ]
      } as any,
      invokeTool: jest.fn()
    });

    expect(callProvider).not.toHaveBeenCalled();
  });

  test('stream loop skips invocation when already exhausted', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { choices: [{ delta: { content: 'final' } }] };
      })
    };

    const events: any[] = [];
    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
        })
      } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'tool.original' }],
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: true,
        maxToolIterations: 0
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      toolNameMap: { tool_sanitized: 'tool.original' },
      metadata: {},
      initialToolCalls: [
        {
          id: 'exhausted',
          name: 'tool.sanitized',
          arguments: {}
        }
      ],
      invokeTool: jest.fn()
    });

    for await (const event of iterator) {
      events.push(event);
    }

    expect(events.some(e => e.type === StreamEventType.TOOL && e.toolEvent?.type === ToolCallEventType.TOOL_RESULT)).toBe(false);
  });

  test('non-stream loop triggers final prompt when tool budget exhausted', async () => {
    const callProvider = jest
      .fn()
      .mockResolvedValueOnce({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'fp',
            name: 'fp_tool',
            arguments: {}
          }
        ]
      })
      .mockResolvedValueOnce({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final message' }]
      });

    await runToolLoop({
      mode: 'nonstream',
      llmManager: { callProvider } as any,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'fp_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: 'true',
        toolFinalPromptEnabled: true,
        maxToolIterations: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: { tools: ['fp_tool'] },
      toolNameMap: { fp_tool: 'fp_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'fp',
            name: 'fp_tool',
            arguments: {}
          }
        ]
      } as any,
      invokeTool: jest.fn().mockResolvedValue({ result: { ok: true } })
    });

    expect(callProvider).toHaveBeenCalled();
  });

  test('parseMaxToolIterations handles invalid strings gracefully', async () => {
    await runToolLoop({
      mode: 'nonstream',
      llmManager: {
        callProvider: jest.fn().mockResolvedValue({
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: []
        })
      } as any,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'parse_tool' }],
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: true,
        toolFinalPromptEnabled: false,
        maxToolIterations: 'invalid'
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: {},
      toolNameMap: { parse_tool: 'parse_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: []
      } as any,
      invokeTool: jest.fn()
    });

    const { normalizeFlag, parseMaxToolIterations, createProgressFields, resolveCountdownText } = __toolLoopTestUtils__;
    expect(normalizeFlag('true', false)).toBe(true);
    expect(normalizeFlag('unknown', true)).toBe(true);
    expect(normalizeFlag({} as any, false)).toBe(true);
    expect(normalizeFlag(1 as any, false)).toBe(true);
    expect(parseMaxToolIterations(3)).toBe(3);
    expect(parseMaxToolIterations('4')).toBe(4);
    expect(parseMaxToolIterations('oops')).toBe(10);
    expect(parseMaxToolIterations(Infinity)).toBe(10);
    const budget = new ToolCallBudget(null);
    expect(createProgressFields(budget)).toBeUndefined();
    expect(resolveCountdownText(false, budget)).toBeUndefined();
    budget.maxCalls = 2;
    expect(resolveCountdownText(true, budget)).toBe('Tool calls used 0 of 2 - 2 remaining.');
  });

  test('safeToolPayloadJson preserves full JSON by default', async () => {
    const { safeToolPayloadJson, safeToolPayloadText } = __toolLoopTestUtils__;
    const payload = { a: { b: { c: { d: { e: { f: { g: 'deep-value' } } } } } } };

    expect(safeToolPayloadJson(payload)).toBe(JSON.stringify(payload));
    expect(safeToolPayloadText(payload)).toBe(JSON.stringify(payload));
  });

  test('safeToolPayloadJson and safeToolPayloadText apply explicit maxBytes bounds', async () => {
    const { safeToolPayloadJson, safeToolPayloadText } = __toolLoopTestUtils__;
    const payload = { text: 'abcdefghijklmnopqrstuvwxyz0123456789' };

    const json = safeToolPayloadJson(payload, { maxBytes: 24 });
    const text = safeToolPayloadText(payload, { maxBytes: 24 });

    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(24);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(24);
    expect(json).not.toBe(JSON.stringify(payload));
    expect(text).not.toBe(JSON.stringify(payload));
  });

  test('safeToolPayloadJson falls back safely for circular payloads', async () => {
    const { safeToolPayloadJson } = __toolLoopTestUtils__;
    const payload: any = { ok: true };
    payload.self = payload;

    const json = safeToolPayloadJson(payload);
    expect(json).toContain('[Circular]');
  });

  test('maybeAttachUsageCost skips when cost already set', async () => {
    const { maybeAttachUsageCost } = __toolLoopTestUtils__;
    const response = {
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cost: 0.5
      }
    } as any;

    await maybeAttachUsageCost(response, { id: 'example-provider' } as any, 'example-model', { usageCost: true });
    expect(response.usage.cost).toBe(0.5);
  });

  test('maybeAttachUsageCost skips when usageCost is missing', async () => {
    const { maybeAttachUsageCost } = __toolLoopTestUtils__;
    const response = {
      usage: {
        promptTokens: 10,
        completionTokens: 5
      }
    } as any;

    await maybeAttachUsageCost(response, { id: 'example-provider' } as any, 'example-model', {});
    expect(response.usage.cost).toBeUndefined();
  });

  test('maybeAttachUsageCost skips when tokens are missing', async () => {
    const { maybeAttachUsageCost } = __toolLoopTestUtils__;
    const missingPrompt = { usage: { completionTokens: 2 } } as any;
    const missingCompletion = { usage: { promptTokens: 2 } } as any;

    await maybeAttachUsageCost(missingPrompt, { id: 'example-provider' } as any, 'example-model', { usageCost: true });
    await maybeAttachUsageCost(missingCompletion, { id: 'example-provider' } as any, 'example-model', { usageCost: true });

    expect(missingPrompt.usage.cost).toBeUndefined();
    expect(missingCompletion.usage.cost).toBeUndefined();
  });

  test('maybeAttachUsageCost computes cost when enabled', async () => {
    const { maybeAttachUsageCost } = __toolLoopTestUtils__;
    const response = {
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 2
      }
    } as any;

    const expected = calculateUsageCost({
      provider: 'example-provider',
      model: 'example-model',
      usage: response.usage
    });

    await maybeAttachUsageCost(response, { id: 'example-provider' } as any, 'example-model', { usageCost: true });
    expect(response.usage.cost).toBe(expected);
  });

  test('final prompt branch handles absent run context', async () => {
    await runToolLoop({
      mode: 'nonstream',
      llmManager: {
        callProvider: jest.fn().mockResolvedValue({
          provider: 'provider',
          model: 'model',
          role: Role.ASSISTANT,
          content: []
        })
      } as any,
      registry: {} as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [{ name: 'fp_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: true,
        toolFinalPromptEnabled: true,
        maxToolIterations: 0
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: undefined,
      toolNameMap: { fp_tool: 'fp_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'fp',
            name: 'fp_tool',
            arguments: {}
          }
        ]
      } as any,
      invokeTool: jest.fn()
    });
  });

  test('non-stream loop writes countdown text when enabled', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'done' }]
    });

    const messages: any[] = [{ role: Role.USER, content: [] }];

    await runToolLoop({
      mode: 'nonstream',
      llmManager: { callProvider } as any,
      registry: {} as any,
      messages,
      tools: [{ name: 'count_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: true,
        maxToolIterations: 2
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      runContext: {},
      toolNameMap: { count_tool: 'count_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'countdown',
            name: 'count_tool',
            arguments: {}
          }
        ]
      } as any,
      invokeTool: jest.fn().mockResolvedValue({ result: { done: true } })
    });

    const countdownMessage = messages.find(msg => msg.role === 'tool')?.content?.find((part: any) => part.type === 'text' && part.text.includes('Tool calls used'));
    expect(countdownMessage).toBeTruthy();
  });

  test('stream loop aggregates reasoning text and metadata across chunks', async () => {
    const chunks = [
      { reasoning: { text: 'Step1 ' } },
      { reasoning: { text: 'and step2', metadata: { step2: true } } },
      { reasoning: { text: ' and finish' } }
    ];

    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })
    };

    const compat = {
      parseStreamChunk: (chunk: any) => chunk
    };

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: { getCompatModule: () => compat } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 1 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: {},
      metadata: {},
      initialToolCalls: [],
      invokeTool: jest.fn()
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const { value, done } = await iterator.next();
      if (done) {
        finalResult = value;
        break;
      }
      events.push(value);
    }

    expect(events).toHaveLength(0);
    expect(finalResult?.reasoning).toEqual({
      text: 'Step1 and step2 and finish',
      metadata: { step2: true }
    });
  });

  test('stream loop parses follow-up tool calls (including pending state) and preserves metadata', async () => {
    const llmManager: any = {
      streamProvider: jest
        .fn()
        .mockReturnValueOnce((async function* () {
          yield {
            toolEvents: [
              {
                type: ToolCallEventType.TOOL_CALL_START,
                callId: '1',
                name: 'test_tool',
                metadata: { started: true }
              },
              {
                type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
                callId: '1',
                argumentsDelta: undefined
              },
              {
                type: ToolCallEventType.TOOL_CALL_END,
                callId: '1',
                name: 'test_tool',
                arguments: '{"a":1}'
              },
              // Duplicate START reintroduces pending state after the callId has been detected.
              { type: ToolCallEventType.TOOL_CALL_START, callId: '1', name: 'test_tool' },
              // Pending call with metadata but no END should be finalized after stream ends.
              {
                type: ToolCallEventType.TOOL_CALL_START,
                callId: '2',
                name: 'test_tool',
                metadata: { pending: true }
              },
              // End with no args -> exercise empty-string fallback.
              { type: ToolCallEventType.TOOL_CALL_START, callId: '3', name: 'test_tool' },
              { type: ToolCallEventType.TOOL_CALL_END, callId: '3', name: 'test_tool' }
            ],
            finishedWithToolCalls: true
          };
        })())
        .mockReturnValueOnce((async function* () {
          // No additional tool calls - end the loop.
        })())
    };

    const compat = {
      parseStreamChunk: (chunk: any) => chunk
    };

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: { getCompatModule: () => compat } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 10 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: {},
      metadata: {},
      initialToolCalls: [],
      invokeTool
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const { value, done } = await iterator.next();
      if (done) {
        finalResult = value;
        break;
      }
      events.push(value);
    }

    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(3);
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(toolCallEvents.some(e => e.toolCall?.metadata)).toBe(true);
    expect(finalResult?.toolCalls?.some((tc: any) => tc.metadata)).toBe(true);
  });

  test('stream loop exits cleanly when provider signals tool_calls finish without any tool events', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { finishedWithToolCalls: true };
      })
    };

    const compat = {
      parseStreamChunk: (chunk: any) => chunk
    };

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: { getCompatModule: () => compat } as any,
      messages: [{ role: Role.USER, content: [] }],
      tools: [],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: { maxToolIterations: 10 } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: {},
      metadata: {},
      initialToolCalls: [],
      invokeTool: jest.fn()
    });

    const events: any[] = [];
    let finalResult: any;
    while (true) {
      const { value, done } = await iterator.next();
      if (done) {
        finalResult = value;
        break;
      }
      events.push(value);
    }

    expect(events).toHaveLength(0);
    expect(finalResult).toBeUndefined();
  });

  test('non-stream loop captures tool execution failures', async () => {
    const llmManager: any = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Done' }]
      })
    };

    const messages = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages,
      tools: [{ name: 'error_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: false,
        maxToolIterations: 1,
        preserveToolResults: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { error_tool: 'error_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-error',
            name: 'error_tool',
            arguments: {}
          }
        ]
      } as any,
      invokeTool: jest.fn().mockRejectedValue('boom')
    });

    const errorResult = result.raw?.toolResults?.find((entry: any) => entry.tool === 'error_tool');
    expect(errorResult?.result).toMatchObject({
      error: 'tool_execution_failed',
      message: 'boom',
      tool: 'error_tool'
    });
  });

  test('non-stream loop preserves reasoning from initial response in messages', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'done' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const reasoning = { text: 'Let me think about this...', metadata: { provider: 'openrouter' } };

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages,
      tools: [{ name: 'reason_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: false,
        maxToolIterations: 1,
        preserveToolResults: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { reason_tool: 'reason_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Calling tool...' }],
        toolCalls: [
          {
            id: 'call-reason',
            name: 'reason_tool',
            arguments: {}
          }
        ],
        reasoning
      } as any,
      invokeTool: jest.fn().mockResolvedValue({ result: 'ok' })
    });

    const assistantMessage = messages.find(msg => msg.role === Role.ASSISTANT);
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage.reasoning).toEqual(reasoning);
  });

  test('stream loop preserves metadata on tool calls (e.g., thoughtSignature)', async () => {
    const llmManager: any = {
      streamProvider: jest.fn(async function* () {
        yield { choices: [{ delta: { content: 'follow-up' } }] };
      })
    };

    const messages: any[] = [{ role: Role.USER, content: [] }];
    const toolCallMetadata = { thoughtSignature: 'abc123...' };

    const iterator = runToolLoop({
      mode: 'stream',
      llmManager,
      registry: {
        getCompatModule: () => ({
          parseStreamChunk: (chunk: any) => ({ text: chunk.choices?.[0]?.delta?.content })
        })
      } as any,
      messages,
      tools: [{ name: 'demo-tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: false,
        maxToolIterations: 1,
        preserveToolResults: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      toolNameMap: { demo_tool: 'demo-tool' },
      metadata: {},
      initialToolCalls: [
        {
          id: 'call-meta',
          name: 'demo_tool',
          arguments: { x: 1 },
          metadata: toolCallMetadata
        }
      ],
      invokeTool: jest.fn().mockResolvedValue({ result: 'ok' })
    });

    for await (const _ of iterator) {
      // Consume all events
    }

    // Verify that the assistant message with tool calls has metadata preserved
    const assistantMessage = messages.find(msg => msg.role === Role.ASSISTANT && msg.toolCalls);
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage.toolCalls[0].metadata).toEqual(toolCallMetadata);
  });

  test('non-stream loop handles response without reasoning gracefully', async () => {
    const callProvider = jest.fn().mockResolvedValue({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'done' }]
    });

    const llmManager: any = {
      callProvider,
      streamProvider: jest.fn()
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: {} as any,
      messages,
      tools: [{ name: 'no_reason_tool' }],
      toolChoice: 'auto',
      providerManifest,
      model: 'model',
      runtime: {
        toolCountdownEnabled: false,
        maxToolIterations: 1,
        preserveToolResults: 1
      } as any,
      providerSettings: {},
      providerExtras: {},
      logger: createLoggerStub(),
      runContext: {},
      toolNameMap: { no_reason_tool: 'no_reason_tool' },
      metadata: {},
      initialResponse: {
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-no-reason',
            name: 'no_reason_tool',
            arguments: {}
          }
        ]
        // No reasoning field
      } as any,
      invokeTool: jest.fn().mockResolvedValue({ result: 'ok' })
    });

    const assistantMessage = messages.find(msg => msg.role === Role.ASSISTANT);
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage).not.toHaveProperty('reasoning');
  });
});
