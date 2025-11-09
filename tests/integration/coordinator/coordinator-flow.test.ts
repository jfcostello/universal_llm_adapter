import { jest } from '@jest/globals';
import { LLMManager } from '@/managers/llm-manager.ts';
import { ToolCoordinator } from '@/utils/tools/tool-coordinator.ts';
import { Role, LLMResponse } from '@/core/types.ts';
import { TOOL_REDACTION_PLACEHOLDER, TOOL_REDACTION_REASON } from '@/utils/context/context-manager.ts';
import { AdapterLogger } from '@/core/logging.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';
import { createFixtureCoordinator } from '@tests/helpers/coordinator.ts';

describe('integration/coordinator/coordinator-flow', () => {
  const originalCwd = process.cwd();
  let originalBatchId: string | undefined;

  beforeAll(() => {
    process.chdir(ROOT_DIR);
  });

  beforeEach(() => {
    originalBatchId = process.env.LLM_ADAPTER_BATCH_ID;
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBatchId === undefined) {
      delete process.env.LLM_ADAPTER_BATCH_ID;
    } else {
      process.env.LLM_ADAPTER_BATCH_ID = originalBatchId;
    }
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  function createBaseSpec(overrides: Partial<any> = {}): any {
    return {
      messages: [
        {
          role: Role.SYSTEM,
          content: [{ type: 'text', text: 'System prompt' }]
        },
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'Please call tools' }]
        }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      mcpServers: ['local'],
      tools: [
        {
          name: 'demo.tool',
          description: 'User supplied tool (sanitized to demo_tool)',
          parametersJsonSchema: {
            type: 'object',
            properties: {}
          }
        }
      ],
      settings: {
        temperature: 0,
        toolCountdownEnabled: true,
        maxToolIterations: 2,
        preserveToolResults: 'all',
        preserveReasoning: 'all'
      },
      metadata: {
        correlationId: 'coord-flow'
      },
      ...overrides
    };
  }

  test('coordinates multi-source tool execution with budget tracking', async () => {
    const coordinator = await createFixtureCoordinator();

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValueOnce({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Calling tool…' }],
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            name: 'local_ping',
            arguments: { payload: 'demo' }
          }
        ]
      } as LLMResponse)
      .mockResolvedValueOnce({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Final answer' }],
        finishReason: 'stop'
      } as LLMResponse);

    const toolInvokeSpy = jest
      .spyOn(ToolCoordinator.prototype, 'routeAndInvoke')
      .mockImplementation(async (toolName) => ({ result: { toolName } }));

    const spec = createBaseSpec({
      metadata: { correlationId: 'coord-budget' }
    });

    const result = await coordinator.run(spec);

    expect(callProviderMock).toHaveBeenCalledTimes(2);

    const offeredTools = callProviderMock.mock.calls[0][4].map(tool => tool.name);
    expect(offeredTools).toEqual(
      expect.arrayContaining(['echo_text', 'demo_tool', 'local_ping', 'local_echo'])
    );

    expect(toolInvokeSpy).toHaveBeenCalledTimes(1);
    expect(toolInvokeSpy.mock.calls[0][0]).toBe('local.ping');

    const callProgress = toolInvokeSpy.mock.calls[0][3].callProgress;
    expect(callProgress).toMatchObject({
      toolCallNumber: 1,
      toolCallTotal: 2,
      toolCallsRemaining: 1,
      finalToolCall: false
    });

    expect(result.content[0].text).toBe('Final answer');
    expect(result.raw?.toolResults?.[0]).toMatchObject({
      tool: 'local.ping',
      result: { toolName: 'local.ping' }
    });

    await coordinator.close();
  });

  test('prunes tool results and reasoning before follow-up calls', async () => {
    const coordinator = await createFixtureCoordinator();

    const firstResponse: LLMResponse = {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Working…' }],
        finishReason: 'tool_calls',
        reasoning: { text: 'internal thoughts' },
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo_text',
            arguments: { text: 'hi' }
          }
        ]
      };

    const responses: LLMResponse[] = [
      firstResponse,
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Final summary' }],
        finishReason: 'stop'
      }
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => {
        if (!responses.length) {
          throw new Error('Unexpected extra provider call');
        }
        return responses.shift()!;
      });

    jest
      .spyOn(ToolCoordinator.prototype, 'routeAndInvoke')
      .mockResolvedValue({ result: 'echoed' });

    const spec = createBaseSpec({
      metadata: { correlationId: 'coord-prune' },
      settings: {
        temperature: 0,
        toolCountdownEnabled: true,
        maxToolIterations: 2,
        preserveToolResults: 0,
        preserveReasoning: 0,
        batchId: 'batch-case-007'
      }
    });

    const result = await coordinator.run(spec);

    expect(result.content[0].text).toBe('Final summary');
    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('batch-case-007');

    // Inspect messages passed to second provider call (after pruning)
    const secondCallMessages = callProviderMock.mock.calls[1][3];
    const toolMessages = secondCallMessages.filter(msg => msg.role === Role.TOOL);
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0].content;
    expect(toolContent[0]).toEqual({ type: 'text', text: TOOL_REDACTION_PLACEHOLDER });
    expect(toolContent[1]).toMatchObject({
      type: 'tool_result',
      result: { redacted: true, reason: TOOL_REDACTION_REASON }
    });

    const reasoningMessages = secondCallMessages.filter(msg => msg.reasoning);
    expect(reasoningMessages.every(msg => msg.reasoning?.redacted === true)).toBe(true);
    expect(firstResponse.reasoning?.text).toBe('internal thoughts');

    await coordinator.close();
  });

  test('collects vector-discovered tools and supplies them to provider call', async () => {
    const adapter = {
      query: jest.fn().mockResolvedValue([
        {
          tool: {
            name: 'vector.tool',
            description: 'Discovered via embeddings',
            parametersJsonSchema: { type: 'object' }
          }
        }
      ]),
      upsert: jest.fn(),
      deleteByIds: jest.fn()
    };

    const vectorManager = new (await import('@/managers/vector-store-manager.ts')).VectorStoreManager(
      new Map(),
      new Map([['memory', adapter]]),
      async () => [0.1, 0.2]
    );

    const coordinator = await createFixtureCoordinator({ vectorManager });

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'vector response' }],
        finishReason: 'stop'
      } as LLMResponse);

    const spec = createBaseSpec({
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'search knowledge base' }] }
      ],
      vectorPriority: ['memory'],
      metadata: { correlationId: 'coord-vector' }
    });

    await coordinator.run(spec);

    const toolsArg = callProviderMock.mock.calls[0][4];
    expect(toolsArg.map((tool: any) => tool.name)).toContain('vector_tool');
    expect(adapter.query).toHaveBeenCalled();

    await coordinator.close();
  });

  test('propagates correlation id to logger while preserving retries', async () => {
    const coordinator = await createFixtureCoordinator();

    const correlationSpy = jest.spyOn(AdapterLogger.prototype, 'withCorrelation');
    const infoSpy = jest.spyOn(AdapterLogger.prototype, 'info');

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Done' }],
        finishReason: 'stop'
      } as LLMResponse);

    const spec = createBaseSpec({
      metadata: { correlationId: 'coord-correlation' }
    });

    await coordinator.run(spec);

    expect(callProviderMock).toHaveBeenCalledTimes(1);
    expect(correlationSpy).toHaveBeenCalledWith('coord-correlation');
    expect(infoSpy).toHaveBeenCalledWith(
      'Calling provider endpoint',
      expect.objectContaining({
        provider: 'test-openai',
        model: 'stub-model'
      })
    );

    await coordinator.close();
  });
});
