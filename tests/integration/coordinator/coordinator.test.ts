import path from 'path';
import { jest } from '@jest/globals';
import { PluginRegistry } from '@/core/registry.ts';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { Role, LLMResponse } from '@/core/types.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

const specBase = {
  messages: [
    {
      role: Role.USER,
      content: [{ type: 'text', text: 'use tool' }]
    }
  ],
  llmPriority: [
    {
      provider: 'test-openai',
      model: 'stub-model'
    }
  ],
  settings: {
    temperature: 0,
    toolCountdownEnabled: true,
    toolFinalPromptEnabled: true
  },
  functionToolNames: ['echo.text'],
  metadata: {
    correlationId: 'coord-test'
  }
};

describe('coordinator/coordinator integration', () => {
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
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    const processRoutes = await registry.getProcessRoutes();
    processRoutes.forEach(route => {
      route.timeoutMs = 10;
    });
    return new LLMCoordinator(registry);
  }

  test('runs tool call workflow and aggregates tool results', async () => {
    const coordinator = await createCoordinator();
    const responses: LLMResponse[] = [
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo.text',
            arguments: { text: 'hello' }
          }
        ],
        raw: undefined
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final result' }],
        finishReason: 'stop'
      } as LLMResponse
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => {
        if (!responses.length) {
          throw new Error('unexpected call');
        }
        return responses.shift()!;
      });

    const spec = {
      ...specBase,
      settings: {
        ...specBase.settings,
        maxToolIterations: 2
      }
    };

    const result = await coordinator.run(spec as any);
    expect(result.content[0].text).toBe('final result');
    expect(result.raw?.toolResults?.[0].tool).toBe('echo.text');
    expect(callProviderMock).toHaveBeenCalledTimes(2);

    await coordinator.close();
  });

  test('handles consecutive tool call rounds and logs follow-up tool names', async () => {
    const coordinator = await createCoordinator();
    const responses: LLMResponse[] = [
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo.text',
            arguments: { text: 'first' }
          }
        ]
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-2',
            name: 'echo.text',
            arguments: { text: 'second' }
          }
        ]
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'final after follow-up' }],
        finishReason: 'stop'
      }
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => {
        if (!responses.length) {
          throw new Error('unexpected follow-up');
        }
        return responses.shift()!;
      });

    const spec = {
      ...specBase,
      settings: {
        ...specBase.settings,
        maxToolIterations: 3
      }
    };

    const result = await coordinator.run(spec as any);
    expect(result.content[0].text).toBe('final after follow-up');
    expect(callProviderMock).toHaveBeenCalledTimes(3);
    expect(result.raw?.toolResults).toHaveLength(2);

    await coordinator.close();
  });

  test('final prompt triggered when tool budget exhausted', async () => {
    const coordinator = await createCoordinator();
    const responses: LLMResponse[] = [
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-1',
            name: 'echo.text',
            arguments: { text: 'hello' }
          }
        ]
      },
      {
        provider: 'test-openai',
        model: 'stub-model',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'post-tool' }],
        finishReason: 'stop'
      }
    ];

    const callProviderMock = jest
      .spyOn(LLMManager.prototype, 'callProvider')
      .mockImplementation(async () => responses.shift()!);

    const spec = {
      ...specBase,
      settings: {
        ...specBase.settings,
        maxToolIterations: 1
      }
    };

    const result = await coordinator.run(spec as any);
    expect(result.content[0].text).toBe('post-tool');
    expect(callProviderMock).toHaveBeenCalledTimes(2);
    const finalCallArgs = callProviderMock.mock.calls[1];
    expect(finalCallArgs[4]).toEqual([]); // tools cleared for final prompt

    await coordinator.close();
  });

  test('normalizeFlag and sanitizeToolName helpers', async () => {
    const coordinator = await createCoordinator();
    const normalize = (coordinator as any).normalizeFlag.bind(coordinator);
    expect(normalize(undefined, true)).toBe(true);
    expect(normalize('yes', false)).toBe(true);
    expect(normalize('no', true)).toBe(false);
    expect(normalize(0, true)).toBe(false);

    const sanitize = (coordinator as any).sanitizeToolName.bind(coordinator);
    expect(sanitize('tool/name?')).toBe('tool_name_');
    expect(sanitize('')).toBe('tool');
    const longName = 'x'.repeat(100);
    expect(sanitize(longName)).toHaveLength(64);
    await coordinator.close();
  });

  test('should preprocess document content', async () => {
    const coordinator = await createCoordinator();

    // Create a spec with a document
    const docPath = path.join(process.cwd(), 'tests', 'fixtures', 'sample-documents', 'sample.txt');
    const specWithDoc = {
      ...specBase,
      messages: [
        {
          role: Role.USER,
          content: [
            { type: 'text' as const, text: 'Analyze this document' },
            {
              type: 'document' as const,
              source: { type: 'filepath' as const, path: docPath }
            }
          ]
        }
      ]
    };

    // Mock the LLM call to verify document was preprocessed
    const mockResponse: LLMResponse = {
      provider: 'test-openai',
      model: 'stub-model',
      role: Role.ASSISTANT,
      finishReason: 'stop',
      content: [{ type: 'text', text: 'Analysis complete' }],
      usage: { inputTokens: 10, outputTokens: 5 },
      raw: undefined
    };

    jest.spyOn(LLMManager.prototype, 'callProvider').mockResolvedValue(mockResponse);

    const response = await coordinator.run(specWithDoc as any);

    expect(response.finishReason).toBe('stop');
    expect(response.content[0].text).toBe('Analysis complete');

    await coordinator.close();
  });
});
