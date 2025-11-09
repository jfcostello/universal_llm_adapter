import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import * as toolDiscovery from '@/utils/tools/tool-discovery.ts';

function createRegistryStub() {
  return {
    getMCPServers: jest.fn().mockReturnValue([]),
    getProcessRoutes: jest.fn().mockReturnValue([]),
    getProvider: jest.fn(),
    getVectorStores: jest.fn().mockReturnValue([])
  } as any;
}

describe('LLMCoordinator guard clauses', () => {
  test('run throws when llmPriority missing', async () => {
    const coordinator = new LLMCoordinator(createRegistryStub());
    await expect(coordinator.run({
      messages: [],
      settings: {},
      llmPriority: []
    } as any)).rejects.toThrow('LLMCallSpec.llmPriority must include at least one provider');
  });

  test('runStream throws when llmPriority missing', async () => {
    const coordinator = new LLMCoordinator(createRegistryStub());
    const iterator = coordinator.runStream({
      messages: [],
      settings: {},
      llmPriority: []
    } as any);

    await expect(iterator.next()).rejects.toThrow(
      'LLMCallSpec.llmPriority must include at least one provider'
    );
  });

  test('run returns provider response untouched when no tool calls detected', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const response = {
      provider: 'stub-provider',
      model: 'stub-model',
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
      finishReason: 'stop',
      usage: {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        reasoningTokens: 50
      }
    } as any;

    const callProvider = jest.fn().mockResolvedValue(response);
    (coordinator as any).llmManager = { callProvider };

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {}
    } as any;

    const result = await coordinator.run(spec);

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(result).toEqual(response);
  });

  test('batch runtime setting resets logger only when value changes', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const initialLogger = (coordinator as any).logger;

    await (coordinator as any).applyRuntimeEnvironment({});

    await (coordinator as any).applyRuntimeEnvironment({ batchId: 'batch-one' });
    const afterFirst = (coordinator as any).logger;
    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('batch-one');
    expect(afterFirst).not.toBe(initialLogger);

    await (coordinator as any).applyRuntimeEnvironment({ batchId: 'batch-one' });
    expect((coordinator as any).logger).toBe(afterFirst);

    delete process.env.LLM_ADAPTER_BATCH_ID;
  });

  test('run throws when provider returns undefined response', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue(undefined)
    };

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response: response was undefined');
  });

  test('run throws when provider response is missing assistant role', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'stub-provider',
        model: 'stub-model',
        role: 'user',
        content: []
      })
    };

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response: missing assistant role');
  });

  test('run throws when provider response content is not an array', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: 'stub-provider',
        model: 'stub-model',
        role: 'assistant',
        content: null
      })
    };

    await expect(coordinator.run(spec)).rejects.toThrow('Malformed LLM response: content must be an array');
  });

  test('run handles provider identifier fallback when response omits provider field', async () => {
    const registry = createRegistryStub();
    registry.getProvider = jest.fn(() => ({ id: 'stub-provider', compat: 'openai' }));
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
      settings: {},
      tools: [],
      functionToolNames: []
    } as any;

    (coordinator as any).llmManager = {
      callProvider: jest.fn().mockResolvedValue({
        provider: undefined,
        model: 'stub-model',
        role: 'assistant',
        content: []
      })
    };

    const result = await coordinator.run(spec);
    expect(result.model).toBe('stub-model');
  });
});
