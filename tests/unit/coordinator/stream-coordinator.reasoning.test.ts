import { jest } from '@jest/globals';
import { ToolCallEventType, Role } from '@/core/types.ts';

const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
if (!unstableMockModule) {
  throw new Error('jest.unstable_mockModule is required for this test suite');
}

describe('StreamCoordinator reasoning aggregation', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  async function createCoordinator(runToolLoopReturn: any) {
    const runToolLoopMock = jest.fn(() => (async function* () {
      return runToolLoopReturn;
    })());

    unstableMockModule('../../../modules/tools/index.js', () => ({
      runToolLoop: runToolLoopMock
    }));

    const { StreamCoordinator } = await import('@/coordinator/stream-coordinator.ts');

    const registry = {
      getCompatModule: jest.fn(() => ({
        parseStreamChunk: (chunk: any) => chunk
      })),
      getProvider: jest.fn(() => ({ id: 'stub-provider', compat: 'stub-compat' }))
    } as any;

    const llmManager = {
      streamProvider: jest.fn()
    } as any;

    const toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } })
    } as any;

    return { StreamCoordinator, registry, llmManager, toolCoordinator, runToolLoopMock };
  }

  test('follow-up reasoning initializes aggregate when none exists', async () => {
    const followUp = {
      content: 'Follow-up content',
      reasoning: { text: 'Follow-up reasoning', metadata: { stage: 'follow' } }
    };
    const { StreamCoordinator, registry, llmManager, toolCoordinator } = await createCoordinator(followUp);

    llmManager.streamProvider.mockImplementation(async function* () {
      yield {
        toolEvents: [{
          type: ToolCallEventType.TOOL_CALL_START,
          callId: 'tool-1',
          name: 'echo.text'
        }],
        finishedWithToolCalls: true
      };
    });

    const coordinator = new StreamCoordinator(registry, llmManager, toolCoordinator);

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }]
    };

    const messages: any[] = [];
    const tools: any[] = [{ name: 'echo_text' }];
    const context = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map([['echo_text', 'echo.text']]),
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() }
    } as any;

    const events: any[] = [];
    const coordinatorStream = coordinator.coordinateStream(spec, messages, tools, context);
    for await (const event of coordinatorStream) {
      events.push(event);
    }

    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.response.reasoning).toEqual({
      text: 'Follow-up reasoning',
      metadata: { stage: 'follow' }
    });
  });

  test('follow-up reasoning merges metadata when aggregate already exists', async () => {
    const followUp = {
      content: 'Follow-up content',
      reasoning: { text: 'Second step', metadata: { stage: 'follow' } }
    };
    const { StreamCoordinator, registry, llmManager, toolCoordinator } = await createCoordinator(followUp);

    llmManager.streamProvider.mockImplementation(async function* () {
      yield {
        reasoning: { text: 'Initial step' }
      };
      yield {
        toolEvents: [{
          type: ToolCallEventType.TOOL_CALL_START,
          callId: 'tool-1',
          name: 'echo.text'
        }],
        finishedWithToolCalls: true
      };
    });

    const coordinator = new StreamCoordinator(registry, llmManager, toolCoordinator);

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }]
    };

    const messages: any[] = [];
    const tools: any[] = [{ name: 'echo_text' }];
    const context = {
      provider: 'stub-provider',
      model: 'stub-model',
      tools,
      mcpServers: [],
      toolNameMap: new Map([['echo_text', 'echo.text']]),
      logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() }
    } as any;

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(spec, messages, tools, context)) {
      events.push(event);
    }

    const done = events.at(-1);
    expect(done.response.reasoning).toEqual({
      text: 'Initial stepSecond step',
      metadata: { stage: 'follow' }
    });
  });

  test('initial stream reasoning merges metadata across chunks', async () => {
    const followUp = undefined;
    const { StreamCoordinator, registry, llmManager, toolCoordinator } = await createCoordinator(followUp);

    llmManager.streamProvider.mockImplementation(async function* () {
      yield {
        reasoning: { text: 'Step one' }
      };
      yield {
        reasoning: { text: ' and two', metadata: { phase: 'final' } }
      };
    });

    const coordinator = new StreamCoordinator(registry, llmManager, toolCoordinator);

    const spec: any = {
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }]
    };

    const events: any[] = [];
    for await (const event of coordinator.coordinateStream(
      spec,
      [],
      [],
      {
        provider: 'stub-provider',
        model: 'stub-model',
        tools: [],
        mcpServers: [],
        toolNameMap: new Map(),
        logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() }
      }
    )) {
      events.push(event);
      if (event.type === 'done') {
        break;
      }
    }

    const done = events.at(-1);
    expect(done.response.reasoning).toEqual({
      text: 'Step one and two',
      metadata: { phase: 'final' }
    });
  });
});
