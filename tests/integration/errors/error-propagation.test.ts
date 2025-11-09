import { jest } from '@jest/globals';
import { PluginRegistry } from '@/core/registry.ts';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { Role, LLMResponse } from '@/core/types.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { ProviderExecutionError } from '@/core/errors.ts';
import { ToolCoordinator } from '@/utils/tools/tool-coordinator.ts';
import { MCPManager } from '@/managers/mcp-manager.ts';
import { AdapterLogger } from '@/core/logging.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

describe('integration/errors/error-propagation', () => {
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

  async function createCoordinator(): Promise<LLMCoordinator> {
    const pluginsDir = (await import('@tests/helpers/paths.ts')).resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    return new LLMCoordinator(registry);
  }

  test('falls back to next provider after rate-limit errors (no extra retries)', async () => {
    const coordinator = await createCoordinator();

    const fallbackResponse: LLMResponse = {
      provider: 'test-openai',
      model: 'ok-model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'ok' }]
    } as any;

    const callMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      // First provider: always throws rate-limit error
      .mockImplementationOnce(async () => {
        throw new ProviderExecutionError('test-openai', 'rate limit', 429, true);
      })
      // Second provider: succeeds
      .mockImplementationOnce(async () => fallbackResponse);

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
      ],
      llmPriority: [
        { provider: 'test-openai', model: 'blocked-model' },
        { provider: 'test-openai', model: 'ok-model' }
      ],
      // Ensure rate-limit schedule is empty so we immediately move to next provider
      rateLimitRetryDelays: [],
      settings: { temperature: 0 },
      metadata: { correlationId: 'error-fallback' }
    } as any;

    const result = await coordinator.run(spec);

    expect(result).toEqual(fallbackResponse);
    // Exactly two provider attempts – first failed, second succeeded
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(callMock.mock.calls[0][1]).toBe('blocked-model');
    expect(callMock.mock.calls[1][1]).toBe('ok-model');

    await coordinator.close();
  });

  test('partitions settings and applies runtime batchId to environment', async () => {
    const coordinator = await createCoordinator();

    const callMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValue({
        provider: 'test-openai',
        model: 'stub',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'done' }]
      } as LLMResponse);

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'ping' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub' }],
      settings: {
        // Provider settings
        temperature: 0,
        maxTokens: 123,
        // Runtime settings
        batchId: 'batch_case_001',
        maxToolIterations: 1,
        // Extras (not in PROVIDER_SETTING_KEYS) – should land in providerExtras
        myCustomFlag: true
      },
      metadata: { correlationId: 'settings-partition' }
    } as any;

    const result = await coordinator.run(spec);

    // Environment variable applied
    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('batch_case_001');

    // Verify provider settings vs extras passed to callProvider
    const [providerManifest, model, providerSettings, _messages, _tools, _toolChoice, providerExtras] = callMock.mock.calls[0];

    expect(providerManifest.id).toBe('test-openai');
    expect(model).toBe('stub');

    // Provider settings only include known provider keys, not runtime ones
    expect(providerSettings).toMatchObject({ temperature: 0, maxTokens: 123 });
    expect((providerSettings as any).batchId).toBeUndefined();
    expect((providerSettings as any).maxToolIterations).toBeUndefined();

    // Extras capture unknown keys
    expect(providerExtras).toMatchObject({ myCustomFlag: true });

    expect(result.content[0].text).toBe('done');
    await coordinator.close();
  });

  test('records tool execution failures and continues orchestration', async () => {
    const coordinator = await createCoordinator();

    jest
      .spyOn(ToolCoordinator.prototype, 'routeAndInvoke')
      .mockRejectedValue(new Error('boom'));

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: {} }
        ]
      } as LLMResponse);

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'invoke tool' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      functionToolNames: ['echo.text'],
      settings: { maxToolIterations: 1, toolFinalPromptEnabled: false }
    } as any;

    const result = await coordinator.run(spec);

    expect(callProviderMock).toHaveBeenCalledTimes(1);
    expect(result.raw?.toolResults?.[0].result).toMatchObject({
      error: 'tool_execution_failed'
    });

    await coordinator.close();
  });

  test('logs MCP gather failures but continues with other discovery sources', async () => {
    const coordinator = await createCoordinator();

    const errorSpy = jest.spyOn(AdapterLogger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(MCPManager.prototype, 'listTools').mockRejectedValue(new Error('mcp down'));

    jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop'
      } as LLMResponse);

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'hello' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      mcpServers: ['local'],
      settings: { temperature: 0 }
    } as any;

    await coordinator.run(spec);

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to list MCP server tools',
      expect.objectContaining({ error: 'mcp down' })
    );

    errorSpy.mockRestore();
    await coordinator.close();
  });

  test('surfaces tool budget exhaustion errors while finalizing response', async () => {
    const coordinator = await createCoordinator();

    const toolInvokeSpy = jest
      .spyOn(ToolCoordinator.prototype, 'routeAndInvoke')
      .mockResolvedValue({ result: { echoed: 'hi' } });

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValueOnce({
        provider: 'test-openai',
        model: 'budget-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: { text: 'hi' } },
          { id: 'call-2', name: 'echo.text', arguments: { text: 'again' } }
        ]
      } as LLMResponse)
      .mockResolvedValueOnce({
        provider: 'test-openai',
        model: 'budget-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Finalized output' }],
        finishReason: 'stop'
      } as LLMResponse);

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'Run limited tool' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'budget-model' }],
      functionToolNames: ['echo.text'],
      settings: {
        maxToolIterations: 1,
        toolFinalPromptEnabled: true,
        toolCountdownEnabled: true
      },
      metadata: { correlationId: 'budget-exhaustion' }
    } as any;

    const response = await coordinator.run(spec);

    const toolResults = response.raw?.toolResults ?? [];
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].tool).toBe('echo.text');
    expect(toolResults.some(result => result.result?.error === 'tool_call_budget_exhausted')).toBe(true);

    expect(toolInvokeSpy).toHaveBeenCalledTimes(1);
    expect(callProviderMock).toHaveBeenCalledTimes(2);
    expect(response.content?.[0]?.text).toBe('Finalized output');
    await coordinator.close();
  });

  test('runStream surfaces provider stream interruption', async () => {
    const coordinator = await createCoordinator();

    const streamSpy = jest
      .spyOn(LLMManager.prototype, 'streamProvider')
      .mockImplementation(async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        throw new Error('stream interrupted');
      });

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    } as any;

    const iterator = coordinator.runStream(spec);
    const drain = async () => {
      for await (const _ of iterator) {
        // consume
      }
    };

    await expect(drain()).rejects.toThrow('stream interrupted');

    streamSpy.mockRestore();
    await coordinator.close();
  });

  test('throws when provider returns malformed assistant response', async () => {
    const coordinator = await createCoordinator();

    const callMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockResolvedValue({
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: null
      } as any);

    const spec = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'hi malformed' }] }
      ],
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      settings: {}
    } as any;

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response');

    callMock.mockRestore();
    await coordinator.close();
  });
});
