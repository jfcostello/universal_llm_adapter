import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { Role } from '@/core/types.ts';
import { ToolCallBudget } from '@/utils/tools/tool-budget.ts';

function createRegistryStub() {
  return {
    getMCPServers: jest.fn().mockReturnValue([]),
    getProcessRoutes: jest.fn().mockReturnValue([]),
    getTool: jest.fn((name: string) => ({
      name,
      description: 'tool',
      parametersJsonSchema: { type: 'object' }
    })),
    getProvider: jest.fn(() => ({
      id: 'provider',
      compat: 'mock',
      endpoint: { urlTemplate: 'http://service/{model}', method: 'POST', headers: {} }
    })),
    getVectorStores: jest.fn().mockReturnValue([]),
    getCompatModule: jest.fn(() => ({
      buildPayload: jest.fn(() => ({})),
      parseResponse: jest.fn(() => ({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'follow-up' }]
      }))
    }))
  } as any;
}

describe('coordinator handleTools loop behaviour', () => {
  test('returns early when no tool calls present', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const response = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'done' }],
      toolCalls: []
    } as any;

    const result = await (coordinator as any).handleTools(
      { settings: {} },
      {},
      {},
      { id: 'provider' },
      'model',
      [],
      [],
      response,
      { info: jest.fn() },
      {},
      {}
    );

    expect(result).toBe(response);
  });

  test('runs follow-up call when budget remains', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const logger = { info: jest.fn() };

    const followUpResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop',
      toolCalls: [],
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        reasoningTokens: 25
      }
    } as any;

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ result: { echoed: true } })
    };

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValueOnce(followUpResponse)
    };

    const spec = {
      settings: {},
      metadata: {}
    } as any;
    const runtime = {
      maxToolIterations: 2,
      toolCountdownEnabled: true
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'func_tool', description: 'desc', parametersJsonSchema: { type: 'object' } }];
    const response = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'needs tool' }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'func_tool',
          arguments: {}
        }
      ]
    } as any;

    const runContext = { tools: ['func_tool'] };
    const toolNameMap = { func_tool: 'func.tool' };

    const result = await (coordinator as any).handleTools(
      spec,
      runtime,
      {},
      { id: 'provider' },
      'model',
      messages,
      tools,
      response,
      logger,
      runContext,
      toolNameMap
    );

    expect((coordinator as any).toolCoordinator.routeAndInvoke).toHaveBeenCalledWith(
      'func.tool',
      'call-1',
      {},
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );

    const callProvider = (coordinator as any).llmManager.callProvider as jest.Mock;
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(callProvider.mock.calls[0][4]).toEqual(tools);
    expect(logger.info).toHaveBeenCalledWith(
      'Follow-up provider response processed',
      expect.objectContaining({
        finishReason: 'stop',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          reasoningTokens: 25
        }
      })
    );
    expect(result).toMatchObject({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'follow-up' }],
      finishReason: 'stop'
    });
  });

  test('runs final prompt when budget exhausted', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const logger = { info: jest.fn() };

    const finalResponse = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'final' }],
      finishReason: 'stop'
    } as any;

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue({ result: { echoed: true } })
    };

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(finalResponse)
    };

    const spec = {
      settings: {},
      metadata: {}
    } as any;
    const runtime = {
      maxToolIterations: 1,
      toolFinalPromptEnabled: true,
      toolCountdownEnabled: true
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'func_tool', description: 'desc', parametersJsonSchema: { type: 'object' } }];
    const response = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'needs tool' }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'func_tool',
          arguments: {}
        }
      ]
    } as any;

    const result = await (coordinator as any).handleTools(
      spec,
      runtime,
      {},
      { id: 'provider' },
      'model',
      messages,
      tools,
      response,
      logger,
      { tools: ['func_tool'] },
      { func_tool: 'func.tool' }
    );

    const callProvider = (coordinator as any).llmManager.callProvider as jest.Mock;
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(callProvider.mock.calls[0][4]).toEqual([]);
    expect(result).toMatchObject({
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'final' }],
      finishReason: 'stop',
      raw: expect.objectContaining({
        toolResults: [{ tool: 'func.tool', result: { echoed: true } }]
      })
    });

    const finalMessage = messages[messages.length - 1];
    expect(finalMessage.role).toBe(Role.USER);
    expect(finalMessage.content[0].text).toContain('All tool calls have been consumed');
    expect(logger.info).toHaveBeenCalledWith(
      'Final response requested after tool budget exhausted',
      expect.objectContaining({ provider: 'provider', model: 'model' })
    );
  });

  test('skips invocation when budget already exhausted', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn()
    };
    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'fallback' }]
      })
    };

    const spec = {
      settings: {},
      metadata: {}
    } as any;
    const runtime = {
      maxToolIterations: '0' as any,
      toolCountdownEnabled: false,
      toolFinalPromptEnabled: false
    };

    const response = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'needs tool' }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'func_tool',
          arguments: {}
        }
      ]
    } as any;

    const messages: any[] = [];
    const result = await (coordinator as any).handleTools(
      spec,
      runtime,
      {},
      { id: 'provider' },
      'model',
      messages,
      [{ name: 'func_tool', description: 'desc', parametersJsonSchema: { type: 'object' } }],
      response,
      logger,
      {},
      { func_tool: 'orig' }
    );

    expect((coordinator as any).toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();
    expect(result.raw.toolResults[0].result.error).toBe('tool_call_budget_exhausted');
  });

  test('handles consume returning false without invoking tool', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);
    const logger = { info: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn()
    };

    const originalConsume = (ToolCallBudget.prototype.consume);
    (ToolCallBudget.prototype as any).consume = jest.fn(() => false);

    const spec = {
      settings: {}
    } as any;
    const runtime = {
      maxToolIterations: 2,
      toolCountdownEnabled: true
    };

    const response = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [],
      toolCalls: [
        { id: 'c1', name: 'func_tool', arguments: {} }
      ]
    } as any;

    await (coordinator as any).handleTools(
      spec,
      runtime,
      {},
      { id: 'provider' },
      'model',
      [],
      [{ name: 'func_tool', description: '', parametersJsonSchema: { type: 'object' } }],
      response,
      logger,
      {},
      { func_tool: 'func.tool' }
    );

    expect((coordinator as any).toolCoordinator.routeAndInvoke).not.toHaveBeenCalled();

    (ToolCallBudget.prototype as any).consume = originalConsume;
  });

  test('captures string tool results in conversation history', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const logger = { info: jest.fn() };

    (coordinator as any).toolCoordinator = {
      routeAndInvoke: jest.fn().mockResolvedValue('plain-result')
    };

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'provider',
        model: 'model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final' }],
        finishReason: 'stop'
      })
    };

    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    const tools = [{ name: 'func_tool', description: 'desc', parametersJsonSchema: { type: 'object' } }];
    const response = {
      provider: 'provider',
      model: 'model',
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'needs tool' }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'func_tool',
          arguments: {}
        }
      ]
    } as any;

    await (coordinator as any).handleTools(
      { settings: {}, metadata: {} },
      { maxToolIterations: 1, toolCountdownEnabled: false },
      {},
      { id: 'provider' },
      'model',
      messages,
      tools,
      response,
      logger,
      { tools: ['func_tool'] },
      { func_tool: 'func.tool' }
    );

    const toolMessages = messages.filter(message => message.role === Role.TOOL);
    expect(toolMessages.some(message =>
      message.content.some((part: any) => part.type === 'text' && part.text === 'plain-result')
    )).toBe(true);
  });
});
