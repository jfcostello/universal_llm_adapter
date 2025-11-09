import { jest } from '@jest/globals';
import { runToolLoop } from '@/utils/tools/tool-loop.ts';
import { PluginRegistry } from '@/core/registry.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { AdapterLogger } from '@/core/logging.ts';
import { Role, LLMResponse } from '@/core/types.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

const loggerStub = (): AdapterLogger => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  logLLMRequest: jest.fn(),
  logLLMResponse: jest.fn(),
  close: jest.fn(),
  withCorrelation: jest.fn().mockReturnThis()
} as unknown as AdapterLogger);

describe('integration/tools/tool-loop', () => {
  const pluginsDir = resolveFixture('plugins', 'basic');
  let registry: PluginRegistry;

  beforeAll(async () => {
    process.chdir(ROOT_DIR);
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
    registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
  });

  const baseOptions = () => ({
    providerManifest: registry.getProvider('test-openai'),
    model: 'stub-model',
    providerSettings: {},
    providerExtras: {},
    toolChoice: 'auto' as const,
    runContext: undefined
  });

  test('executes tool calls sequentially, emits countdown text, and appends final prompt when budget exhausted', async () => {
    const llmManager = {
      callProvider: jest
        .fn()
        .mockResolvedValueOnce({
          provider: 'test-openai',
          model: 'stub-model',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Final response' }]
        } as LLMResponse)
        .mockResolvedValueOnce({
          provider: 'test-openai',
          model: 'stub-model',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'User facing summary' }]
        } as LLMResponse)
    } as unknown as LLMManager;

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Request' }] }
    ];

    const invokeTool = jest
      .fn()
      .mockResolvedValueOnce({ result: { echoed: 'hello' } });

    const toolNameMap = {
      'echo.text': 'echo.text',
      echo_text: 'echo.text'
    };

    const runtime = {
      toolCountdownEnabled: true,
      toolFinalPromptEnabled: true,
      maxToolIterations: 1,
      preserveToolResults: 'all' as const,
      preserveReasoning: 'all' as const
    };

    const response = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry,
      messages,
      tools: [
        {
          name: 'echo_text',
          description: 'Echo tool',
          parametersJsonSchema: {
            type: 'object',
            properties: { text: { type: 'string' } }
          }
        }
      ],
      toolChoice: 'auto',
      providerManifest: baseOptions().providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap,
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Working…' }],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: { text: 'hello' } },
          { id: 'call-2', name: 'echo.text', arguments: { text: 'ignored' } }
        ]
      }
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      'echo.text',
      expect.objectContaining({ id: 'call-1' }),
      expect.objectContaining({ callProgress: expect.objectContaining({ toolCallNumber: 1 }) })
    );

    // Countdown text should be appended to the tool message when exhausted
    const toolMessages = messages.filter(msg => msg.role === Role.TOOL);
    const countdownMessage = toolMessages[toolMessages.length - 1];
    expect(countdownMessage.content.some(part => part.type === 'text' && /remaining/.test(part.text))).toBe(true);

    // Final prompt should be appended as a user message
    expect(messages.some(msg => msg.role === Role.USER && /All tool calls have been consumed/.test(msg.content[0].text))).toBe(true);

    // llmManager called once for the final prompt request
    const manager = llmManager as unknown as { callProvider: jest.Mock };
    expect(manager.callProvider).toHaveBeenCalledTimes(1);

    // Response includes raw tool results with error payload for the skipped call
    expect(response.raw?.toolResults).toHaveLength(2);
    const exhaustedResult = response.raw?.toolResults?.find((r: any) => r.result?.error === 'tool_call_budget_exhausted');
    expect(exhaustedResult).toBeDefined();
  });

  test('continues execution when invokeTool throws and records error result', async () => {
    const llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Done' }]
      } as LLMResponse)
    } as unknown as LLMManager;

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Run tool' }] }
    ];

    const invokeTool = jest.fn().mockRejectedValue(new Error('tool failed'));

    const runtime = {
      toolCountdownEnabled: true,
      toolFinalPromptEnabled: false,
      maxToolIterations: 2,
      preserveToolResults: 'all' as const,
      preserveReasoning: 'all' as const
    };

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: baseOptions().providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap: { 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-err', name: 'echo.text', arguments: { text: 'failing' } }
        ]
      }
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.raw?.toolResults?.[0].result).toMatchObject({
      error: 'tool_execution_failed'
    });
    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage?.content?.[0]?.type).toBe('text');
    expect(toolMessage?.content?.[0]?.text).toContain('tool_execution_failed');
    expect(toolMessage?.content?.some(part => part.type === 'text' && /remaining/.test(part.text))).toBe(true);
  });

  test('runToolLoop handles non-Error exceptions (e.g., string throws)', async () => {
    const llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Done after error' }]
      } as LLMResponse)
    } as unknown as LLMManager;

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Test non-Error throw' }] }
    ];

    // Reject with null to test the else branch
    const invokeTool = jest.fn().mockImplementation(() => {
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject(null);
    });

    const runtime = {
      toolCountdownEnabled: true,
      toolFinalPromptEnabled: false,
      maxToolIterations: 1,
      preserveToolResults: 3,
      preserveReasoning: 3
    };

    const result = await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: baseOptions().registry,
      messages,
      tools: [{ name: 'echo.text' }],
      toolChoice: 'auto',
      runContext: {},
      metadata: {},
      providerManifest: baseOptions().providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap: { 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-str', name: 'echo.text', arguments: { text: 'test' } }
        ]
      }
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.raw?.toolResults?.[0].result).toMatchObject({
      error: 'tool_execution_failed'
    });
    // String(null) = 'null'
    expect(result.raw?.toolResults?.[0].result.message).toBe('null');
    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage?.content?.[0]?.text).toContain('tool_execution_failed');
  });

  test('runToolLoop handles non-Error exceptions in parallel execution', async () => {
    const pendingResolvers: Record<string, { resolve?: (value: any) => void; reject?: (error: any) => void }> = {};

    const llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Done after errors' }]
      } as LLMResponse)
    } as unknown as LLMManager;

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Test parallel non-Error throw' }] }
    ];

    // Create promises that we can manually resolve/reject
    const invokeTool = jest.fn().mockImplementation((_tool, call) => {
      return new Promise((resolve, reject) => {
        pendingResolvers[call.id] = { resolve, reject };
      });
    });

    const runtime = {
      toolCountdownEnabled: false,
      toolFinalPromptEnabled: false,
      maxToolIterations: 2,
      parallelToolExecution: true,
      preserveToolResults: 'all' as const,
      preserveReasoning: 'all' as const
    };

    const loopPromise = runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry: baseOptions().registry,
      messages,
      tools: [{ name: 'echo.text' }],
      toolChoice: 'auto',
      runContext: {},
      metadata: {},
      providerManifest: baseOptions().providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap: { 'echo.text': 'echo.text', 'echo.reverse': 'echo.reverse' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: { text: 'test1' } },
          { id: 'call-2', name: 'echo.reverse', arguments: { text: 'test2' } }
        ],
        finishReason: 'tool_calls'
      }
    });

    await Promise.resolve();
    expect(invokeTool).toHaveBeenCalledTimes(2);

    // Resolve first, reject second with non-Error (primitive number)
    pendingResolvers['call-1'].resolve!({ result: 'success1' });
    // eslint-disable-next-line prefer-promise-reject-errors
    pendingResolvers['call-2'].reject!(404);

    const result = await loopPromise;

    // Check that primitive error was converted to string
    const errorResult = result.raw?.toolResults?.find((r: any) => r.tool === 'echo.reverse');
    expect(errorResult?.result).toMatchObject({
      error: 'tool_execution_failed',
      message: '404'
    });
  });

  test('parallel execution invokes tools concurrently and truncates large results', async () => {
    const pendingResolvers: Record<string, () => void> = {};

    const llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Final answer' }]
      } as LLMResponse)
    } as unknown as LLMManager;

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Parallel tools' }] }
    ];

    const invokeTool = jest.fn().mockImplementation((_tool, call) => {
      return new Promise(resolve => {
        pendingResolvers[call.id] = () => resolve({ result: 'X'.repeat(50) });
      });
    });

    const runtime = {
      toolCountdownEnabled: false,
      toolFinalPromptEnabled: false,
      maxToolIterations: 2,
      parallelToolExecution: true,
      toolResultMaxChars: 10,
      preserveToolResults: 'all' as const,
      preserveReasoning: 'all' as const
    };

    const loopPromise = runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: baseOptions().providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap: { 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: { text: 'a' } },
          { id: 'call-2', name: 'echo.text', arguments: { text: 'b' } }
        ],
        finishReason: 'tool_calls'
      }
    });

    await Promise.resolve();
    expect(invokeTool).toHaveBeenCalledTimes(2);

    pendingResolvers['call-1']();
    pendingResolvers['call-2']();

    const response = await loopPromise;
    expect(response.raw?.toolResults).toHaveLength(2);

    const toolMessages = messages.filter(msg => msg.role === Role.TOOL);
    toolMessages.forEach(msg => {
      const textPart = msg.content.find(part => part.type === 'text' && part.text.includes('…')) as any;
      expect(textPart).toBeDefined();
      expect(textPart.text.length).toBeLessThanOrEqual(11);
      expect(msg.content.some(part => part.type === 'text' && /truncated/.test(part.text))).toBe(true);
    });
  });

  test('streaming mode handles non-Error exceptions', async () => {
    // Ensure compat module is loaded for streaming path
    const providerManifest = await registry.getProvider('test-openai');
    await registry.getCompatModule(providerManifest.compat);

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Test streaming error' }] }
    ];

    const invokeTool = jest.fn().mockImplementation(() => {
      // Reject with null to test the else branch in streaming path
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject(null);
    });

    const runtime = {
      toolCountdownEnabled: false,
      toolFinalPromptEnabled: false,
      maxToolIterations: 1,
      preserveToolResults: 'all' as const,
      preserveReasoning: 'all' as const
    };

    // Mock llmManager with streamProvider
    const llmManager = {
      streamProvider: async function* () {
        yield { choices: [{ delta: { content: 'response' } }] };
      }
    } as any;

    const streamGen = runToolLoop({
      mode: 'stream',
      llmManager,
      registry,
      messages,
      tools: [{ name: 'echo.text' }],
      toolChoice: 'auto',
      runContext: {},
      metadata: {},
      providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap: { 'echo.text': 'echo.text' },
      invokeTool,
      initialToolCalls: [
        { id: 'call-1', name: 'echo.text', arguments: { text: 'test' } }
      ]
    });

    // Consume the stream
    const events: any[] = [];
    for await (const event of streamGen) {
      events.push(event);
    }

    expect(invokeTool).toHaveBeenCalledTimes(1);
    // Verify error was handled and converted to string
    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage).toBeDefined();
  });

  test('normalizes string tool results without truncation when limit absent', async () => {
    const llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }]
      } as LLMResponse)
    } as unknown as LLMManager;

    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'String result please' }] }
    ];

    const invokeTool = jest.fn().mockResolvedValue('raw-string-result');

    const runtime = {
      toolCountdownEnabled: false,
      toolFinalPromptEnabled: false,
      maxToolIterations: 1,
      preserveToolResults: 'all' as const,
      preserveReasoning: 'all' as const
    };

    await runToolLoop({
      mode: 'nonstream',
      llmManager,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: baseOptions().providerManifest,
      model: baseOptions().model,
      runtime,
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub(),
      toolNameMap: { 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: {} }
        ]
      }
    });

    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage).toBeDefined();
    const textPart = toolMessage!.content.find((part: any) => part.type === 'text') as any;
    expect(textPart.text).toBe('raw-string-result');
    expect(toolMessage!.content.some((part: any) => /truncated/i.test(part.text))).toBe(false);
  });
});
