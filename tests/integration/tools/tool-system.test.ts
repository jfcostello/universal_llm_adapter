import { jest } from '@jest/globals';
import type { PluginRegistry } from '@/core/registry.ts';
import { collectTools } from '@/utils/tools/tool-discovery.ts';
import { MCPManager } from '@/managers/mcp-manager.ts';
import { VectorStoreManager } from '@/managers/vector-store-manager.ts';
import { ToolCoordinator } from '@/utils/tools/tool-coordinator.ts';
import { Role, LLMResponse } from '@/core/types.ts';
import { runToolLoop } from '@/utils/tools/tool-loop.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';
import {
  loadBasicRegistry,
  createLoggerStub,
  createLLMManagerMock,
  cloneMessages
} from '@tests/integration/helpers/test-builders.ts';

describe('integration/tools/tool-system', () => {
  const originalCwd = process.cwd();
  let registry: PluginRegistry;
  const loggerStub = createLoggerStub();

  beforeAll(() => {
    process.chdir(ROOT_DIR);
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    registry = await loadBasicRegistry();
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  test('collectTools merges registry tools and MCP-discovered tools with sanitization', async () => {
    const servers = [
      {
        id: 'localmcp',
        command: 'node',
        args: ['./tests/fixtures/mcp/server.mjs'],
        autoStart: true
      }
    ];
    const mcpManager = new MCPManager(servers);

    try {
      const spec: any = {
        messages: [
          { role: Role.USER, content: [{ type: 'text', text: 'use tools' }] }
        ],
        functionToolNames: ['echo.text'],
        mcpServers: ['localmcp']
      };

      const result = await collectTools({ spec, registry, mcpManager });

      expect(result.tools.some(t => t.name === 'echo_text')).toBe(true);
      const mcpToolNames = result.tools.map(t => t.name);
      expect(mcpToolNames).toEqual(expect.arrayContaining(['localmcp_ping', 'localmcp_echo']));
      expect(result.toolNameMap['localmcp_ping']).toBe('localmcp.ping');
      expect(result.toolNameMap['localmcp_echo']).toBe('localmcp.echo');
      expect(result.toolNameMap['echo_text']).toBe('echo.text');
      expect(result.mcpServers).toEqual(['localmcp']);
    } finally {
      await mcpManager.close();
    }
  });

  test('collectTools de-duplicates overlapping tools while preserving original mapping', async () => {
    const spec: any = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
      ],
      tools: [
        {
          name: 'echo.text',
          description: 'Inline tool definition',
          parametersJsonSchema: { type: 'object' }
        }
      ],
      functionToolNames: ['echo.text']
    };

    const result = await collectTools({ spec, registry });
    expect(result.tools.filter(t => t.name === 'echo_text')).toHaveLength(1);
    expect(result.toolNameMap.echo_text).toBe('echo.text');
  });

  test('collectTools includes vector store recommendations and sanitizes names', async () => {
    const adapter = {
      query: jest.fn().mockResolvedValue([
        {
          tool: {
            name: 'vector.tool',
            description: 'Suggested by embeddings',
            parametersJsonSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' }
              }
            }
          }
        }
      ]),
      upsert: jest.fn(),
      deleteByIds: jest.fn()
    };

    const vectorManager = new VectorStoreManager(
      new Map(),
      new Map([['memory', adapter]]),
      async () => [0.1, 0.2, 0.3]
    );

    const spec: any = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'Need search assistance' }] }
      ],
      vectorPriority: ['memory']
    };

    const result = await collectTools({ spec, registry, vectorManager });
    expect(adapter.query).toHaveBeenCalledWith(expect.any(Array), 5, undefined);
    expect(result.tools.some(tool => tool.name === 'vector_tool')).toBe(true);
    expect(result.toolNameMap.vector_tool).toBe('vector.tool');
  });

  test('ToolCoordinator surfaces validation errors from module routes', async () => {
    const processRoutes = await registry.getProcessRoutes();
    const coordinator = new ToolCoordinator(processRoutes);

    await expect(
      coordinator.routeAndInvoke('validate.tool', 'call-err', {}, { provider: 'test', model: 'stub' })
    ).rejects.toThrow('value parameter must be a number');
  });

  test('collectTools uses metadata vectorQuery when provided', async () => {
    const adapter = {
      query: jest.fn().mockResolvedValue([
        {
          name: 'direct.tool',
          description: 'Direct unified tool from vector store',
          parametersJsonSchema: { type: 'object' }
        }
      ]),
      upsert: jest.fn(),
      deleteByIds: jest.fn()
    };

    const vectorManager = new VectorStoreManager(
      new Map(),
      new Map([['memory', adapter]]),
      async () => [0.5, 0.6]
    );

    const spec: any = {
      messages: [],
      vectorPriority: ['memory'],
      metadata: {
        vectorQuery: 'metadata supplied query'
      }
    };

    const result = await collectTools({ spec, registry, vectorManager });
    expect(adapter.query).toHaveBeenCalled();
    const toolNames = result.tools.map(tool => tool.name);
    expect(toolNames).toContain('direct_tool');
    expect(result.toolNameMap.direct_tool).toBe('direct.tool');
  });

  test('collectTools ignores vector errors and continues discovery', async () => {
    const vectorManager = {
      queryWithPriority: jest.fn().mockRejectedValue(new Error('vector failure'))
    } as unknown as VectorStoreManager;

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const spec: any = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'query me' }] }
      ],
      vectorPriority: ['memory'],
      functionToolNames: ['echo.text']
    };

    const result = await collectTools({ spec, registry, vectorManager });
    expect(result.tools.some(tool => tool.name === 'echo_text')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('collectTools ignores invalid vector results', async () => {
    const adapter = {
      query: jest.fn().mockResolvedValue([{ unexpected: true }]),
      upsert: jest.fn(),
      deleteByIds: jest.fn()
    };

    const vectorManager = new VectorStoreManager(
      new Map(),
      new Map([['memory', adapter]]),
      async () => [0.2, 0.3]
    );

    const spec: any = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'search query' }] }
      ],
      vectorPriority: ['memory'],
      functionToolNames: ['echo.text']
    };

    const result = await collectTools({ spec, registry, vectorManager });
    expect(result.tools.some(tool => tool.name === 'echo_text')).toBe(true);
    expect(result.tools.some(tool => tool.name === 'unexpected')).toBe(false);
  });

  test('collectTools adds top-level vector tool definitions and uses latest user query', async () => {
    const adapter = {
      query: jest.fn().mockResolvedValue([
        {
          name: 'vector.direct',
          description: 'Top-level tool definition',
          parametersJsonSchema: { type: 'object' }
        }
      ]),
      upsert: jest.fn(),
      deleteByIds: jest.fn()
    };

    const embedSpy = jest.fn().mockResolvedValue([0.4, 0.5]);

    const vectorManager = new VectorStoreManager(
      new Map(),
      new Map([['memory', adapter]]),
      embedSpy
    );

    const spec: any = {
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'initial query' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text', text: 'ack' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'final query' }] }
      ],
      vectorPriority: ['memory']
    };

    const result = await collectTools({ spec, registry, vectorManager });
    expect(embedSpy).toHaveBeenCalledWith('final query');
    expect(result.tools.some(tool => tool.name === 'vector_direct')).toBe(true);
    expect(result.toolNameMap.vector_direct).toBe('vector.direct');
  });

  test('collectTools skips vector lookup when no query is available', async () => {
    const vectorManager = {
      queryWithPriority: jest.fn()
    } as unknown as VectorStoreManager;

    const spec: any = {
      messages: [],
      vectorPriority: ['memory']
    };

    await collectTools({ spec, registry, vectorManager });
    expect((vectorManager.queryWithPriority as jest.Mock)).not.toHaveBeenCalled();
  });

  test('runToolLoop enforces sequential execution and emits countdown messaging', async () => {
    const manager = createLLMManagerMock({
      callResponses: [
        {
          provider: 'test-openai',
          model: 'stub',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'complete' }]
        } as LLMResponse
      ]
    });

    const invokeOrder: string[] = [];
    const invokeTool = jest.fn().mockImplementation(async (_toolName, call) => {
      invokeOrder.push(call.id);
      return { result: { echoed: call.arguments.text } };
    });

    const messages = [
      { role: Role.USER, content: [{ type: 'text', text: 'Need two calls' }] }
    ];

    await runToolLoop({
      mode: 'nonstream',
      llmManager: manager as any,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: registry.getProvider('test-openai'),
      model: 'stub',
      runtime: {
        maxToolIterations: 1,
        toolCountdownEnabled: true,
        toolFinalPromptEnabled: false,
        preserveReasoning: 'all',
        preserveToolResults: 'all'
      },
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub,
      toolNameMap: { echo_text: 'echo.text', 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: { text: 'first' } },
          { id: 'call-2', name: 'echo.text', arguments: { text: 'second' } }
        ]
      }
    });

    expect(invokeOrder).toEqual(['call-1']);
    const toolMessages = messages.filter(msg => msg.role === Role.TOOL);
    expect(toolMessages).toHaveLength(2);
    const countdownText = toolMessages.at(-1)?.content.find(
      part => part.type === 'text' && /Tool calls used/i.test(part.text)
    );
    expect(countdownText).toBeDefined();
  });

  test('runToolLoop executes tools in parallel when enabled and truncates long payloads', async () => {
    const manager = createLLMManagerMock({
      callResponses: [
        {
          provider: 'test-openai',
          model: 'stub',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'complete' }]
        }
      ]
    });

    let concurrent = 0;
    const peakConcurrent: number[] = [];
    const deferred: Record<string, () => void> = {};

    const invokeTool = jest.fn().mockImplementation(
      (_toolName, call) =>
        new Promise(resolve => {
          concurrent += 1;
          peakConcurrent.push(concurrent);
          deferred[call.id] = () => {
            concurrent -= 1;
            resolve({ result: 'X'.repeat(40) });
          };
        })
    );

    const messages = [
      { role: Role.USER, content: [{ type: 'text', text: 'run parallel' }] }
    ];

    const loopPromise = runToolLoop({
      mode: 'nonstream',
      llmManager: manager as any,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: registry.getProvider('test-openai'),
      model: 'stub',
      runtime: {
        maxToolIterations: 3,
        toolCountdownEnabled: false,
        parallelToolExecution: true,
        toolResultMaxChars: 8,
        preserveReasoning: 'all',
        preserveToolResults: 'all'
      },
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub,
      toolNameMap: { echo_text: 'echo.text', 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'echo.text', arguments: { text: 'a' } },
          { id: 'call-2', name: 'echo.text', arguments: { text: 'b' } }
        ]
      }
    });

    await Promise.resolve();
    deferred['call-1']?.();
    deferred['call-2']?.();
    await loopPromise;

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(Math.max(...peakConcurrent)).toBeGreaterThan(1);

    const toolMessages = messages.filter(msg => msg.role === Role.TOOL);
    expect(toolMessages).toHaveLength(2);
    for (const msg of toolMessages) {
      const truncated = msg.content.find(
        part => part.type === 'text' && part.text.endsWith('…')
      );
      expect(truncated).toBeDefined();
      expect(msg.content.some(part => part.type === 'text' && /truncated/i.test(part.text))).toBe(true);
    }
  });

  test('runToolLoop records tool errors and continues budget countdown', async () => {
    const manager = createLLMManagerMock({
      callResponses: [
        {
          provider: 'test-openai',
          model: 'stub',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'complete' }]
        }
      ]
    });

    const invokeTool = jest.fn().mockRejectedValue(new Error('boom'));
    const messages = [
      { role: Role.USER, content: [{ type: 'text', text: 'cause failure' }] }
    ];

    const response = await runToolLoop({
      mode: 'nonstream',
      llmManager: manager as any,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: registry.getProvider('test-openai'),
      model: 'stub',
      runtime: {
        maxToolIterations: 2,
        toolCountdownEnabled: true,
        toolFinalPromptEnabled: false,
        preserveReasoning: 'all',
        preserveToolResults: 'all'
      },
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub,
      toolNameMap: { echo_text: 'echo.text', 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'call-err', name: 'echo.text', arguments: {} }
        ]
      }
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const toolMessage = messages.find(msg => msg.role === Role.TOOL);
    expect(toolMessage?.content.some(part => part.type === 'text' && part.text.includes('tool_execution_failed'))).toBe(true);
    expect(response.raw?.toolResults?.[0]?.result?.error).toBe('tool_execution_failed');
  });

  test('runToolLoop appends final prompt when budget exhausted and countdown enabled', async () => {
    const manager = createLLMManagerMock({
      callResponses: [
        {
          provider: 'test-openai',
          model: 'stub',
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'final' }]
        }
      ]
    });

    const invokeTool = jest.fn().mockResolvedValue({ result: { ok: true } });
    const messages = cloneMessages([
      { role: Role.USER, content: [{ type: 'text', text: 'exhaust budget' }] }
    ]);

    await runToolLoop({
      mode: 'nonstream',
      llmManager: manager as any,
      registry,
      messages,
      tools: [
        { name: 'echo_text', description: 'Echo', parametersJsonSchema: { type: 'object' } }
      ],
      toolChoice: 'auto',
      providerManifest: registry.getProvider('test-openai'),
      model: 'stub',
      runtime: {
        maxToolIterations: 0,
        toolCountdownEnabled: true,
        toolFinalPromptEnabled: true,
        preserveReasoning: 'all',
        preserveToolResults: 'all'
      },
      providerSettings: {},
      providerExtras: {},
      logger: loggerStub,
      toolNameMap: { echo_text: 'echo.text', 'echo.text': 'echo.text' },
      invokeTool,
      initialResponse: {
        provider: 'test-openai',
        model: 'stub',
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          { id: 'blocked', name: 'echo.text', arguments: {} }
        ]
      }
    });

    const countdownMessage = messages.find(
      msg =>
        msg.role === Role.TOOL &&
        msg.content.some(part => part.type === 'text' && /Tool calls used/i.test(part.text))
    );
    expect(countdownMessage).toBeDefined();

    const finalPrompt = messages.find(
      msg =>
        msg.role === Role.USER &&
        msg.content.some(part => part.type === 'text' && part.text.includes('All tool calls have been consumed'))
    );
    expect(finalPrompt).toBeDefined();
  });
});
