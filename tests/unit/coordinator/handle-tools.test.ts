import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { Role } from '@/core/types.ts';
import { ToolCallBudget } from '@/utils/tools/tool-budget.ts';

function createRegistryStub() {
  const registry = {
    getMCPServers: () => [],
    getProcessRoutes: () => [],
    getTool: jest.fn(() => ({
      name: 'tool.echo',
      description: 'Echo tool'
    })),
    getProvider: jest.fn((id: string) => ({ id })),
    getVectorStores: () => [],
    getVectorStore: jest.fn()
  };

  return registry;
}

function createCoordinator() {
  const registry = createRegistryStub();
  const coordinator = new LLMCoordinator(registry as any);

  const toolCoordinator = {
    routeAndInvoke: jest.fn().mockResolvedValue({ result: { echoed: true } }),
    close: jest.fn().mockResolvedValue(undefined)
  };

  const llmManager = {
    callProvider: jest.fn().mockResolvedValue({
      provider: 'test',
      model: 'retry',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'final' }],
      finishReason: 'stop'
    })
  };

  (coordinator as any).toolCoordinator = toolCoordinator;
  (coordinator as any).llmManager = llmManager;

  return { coordinator, toolCoordinator, llmManager };
}

describe('LLMCoordinator.handleTools edge cases', () => {
  test('skips invocation when tool budget already exhausted', async () => {
    const { coordinator, toolCoordinator, llmManager } = createCoordinator();
    const logger = { info: jest.fn() };

    const spec = {
      settings: {}
    };
    const runtime = {
      maxToolIterations: '0' as any,
      toolCountdownEnabled: true,
      toolFinalPromptEnabled: false
    };

    const response = {
      provider: 'test',
      model: 'stub',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'tool.echo',
          arguments: {}
        }
      ],
      raw: undefined
    };

    const messages: any[] = [{ role: Role.USER, content: [] }];

    const result = await (coordinator as any).handleTools(
      spec,
      runtime,
      {},
      { id: 'test-provider' },
      'stub-model',
      messages,
      [],
      response,
      logger,
      {},
      { 'tool.echo': 'tool.echo' }
    );

    expect(toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();
    expect(llmManager.callProvider).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Tool budget exhausted; skipping invocation',
      expect.objectContaining({ toolName: 'tool.echo' })
    );
    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage).toBeDefined();
    expect(toolMessage.content[1]).toEqual({
      type: 'tool_result',
      toolName: 'tool.echo',
      result: expect.objectContaining({ error: 'tool_call_budget_exhausted' })
    });
    expect(result.raw?.toolResults?.[0].result.error).toBe('tool_call_budget_exhausted');
  });

  test('stops processing when consume is blocked despite remaining budget', async () => {
    const { coordinator, toolCoordinator, llmManager } = createCoordinator();
    const logger = { info: jest.fn() };

    const spec = { settings: {} };
    const runtime = {
      maxToolIterations: 2,
      toolCountdownEnabled: false,
      toolFinalPromptEnabled: false
    };

    const response = {
      provider: 'test',
      model: 'stub',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'tool.echo',
          arguments: {}
        }
      ],
      raw: undefined
    };

    const messages: any[] = [{ role: Role.USER, content: [] }];

    const originalConsume = ToolCallBudget.prototype.consume;
    ToolCallBudget.prototype.consume = function consumeOverride() {
      return false;
    };

    try {
      const result = await (coordinator as any).handleTools(
        spec,
        runtime,
        {},
        { id: 'test-provider' },
        'stub-model',
        messages,
        [],
        response,
        logger,
        {},
        { 'tool.echo': 'tool.echo' }
      );

      expect(toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();
      expect(llmManager.callProvider).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Tool budget consumption blocked invocation',
        expect.objectContaining({ toolName: 'tool.echo' })
      );
      expect(result.raw?.toolResults?.[0].result).toMatchObject({
        error: 'tool_call_budget_exhausted'
      });
    } finally {
      ToolCallBudget.prototype.consume = originalConsume;
    }
  });

  test('uses default runtime settings and normalizes raw string tool outputs', async () => {
    const { coordinator, toolCoordinator, llmManager } = createCoordinator();
    const logger = { info: jest.fn() };

    toolCoordinator.routeAndInvoke.mockResolvedValue('raw-tool-output');

    const spec = {
      settings: {}
    };

    const response = {
      provider: 'test',
      model: 'stub',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'tool.echo',
          arguments: {}
        }
      ],
      raw: undefined
    };

    const messages: any[] = [{ role: Role.USER, content: [] }];

    const result = await (coordinator as any).handleTools(
      spec,
      {},
      {},
      { id: 'test-provider' },
      'stub-model',
      messages,
      [],
      response,
      logger,
      {},
      { 'tool.echo': 'tool.echo' }
    );

    expect(toolCoordinator.routeAndInvoke).toHaveBeenCalledTimes(1);
    expect(llmManager.callProvider).toHaveBeenCalledTimes(1);
    expect(result.raw?.toolResults?.[0].result).toBe('raw-tool-output');
    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage?.content[0].text).toBe('raw-tool-output');
  });

  test('parseMaxToolIterations handles null, numeric, string, and invalid values', () => {
    const { coordinator } = createCoordinator();
    const parse = (coordinator as any).parseMaxToolIterations.bind(coordinator);

    expect(parse(undefined)).toBe(10);
    expect(parse(null)).toBe(10);
    expect(parse(7.9)).toBe(7);
    expect(parse('12')).toBe(12);
    expect(parse('invalid')).toBe(10);
    expect(parse(Infinity)).toBe(10);
  });
});
