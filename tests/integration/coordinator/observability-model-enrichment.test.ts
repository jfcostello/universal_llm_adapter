import { jest } from '@jest/globals';
import { PluginRegistry, Role, type ObservabilityContext } from '@/kernel/index.ts';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

describe('coordinator observability model enrichment (integration)', () => {
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

  async function createRegistry(): Promise<PluginRegistry> {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const registry = new PluginRegistry(pluginsDir);
    await registry.loadAll();
    return registry;
  }

  function createStubObservabilityContext(options?: {
    correlationId?: string;
    traceId?: string;
    sessionId?: string;
  }): {
    context: ObservabilityContext;
    exporter: {
      recordLLMRequest: jest.Mock;
      recordLLMResponse: jest.Mock;
      flush: jest.Mock;
    };
  } {
    const exporter = {
      recordLLMRequest: jest.fn().mockReturnValue({ queued: true }),
      recordLLMResponse: jest.fn().mockReturnValue({ queued: true }),
      flush: jest.fn().mockResolvedValue(undefined)
    };

    const correlationId = options?.correlationId ?? 'obs-int-test';
    const context: ObservabilityContext = {
      exporter: exporter as any,
      traceId: options?.traceId ?? 'trace-123',
      sessionId: options?.sessionId ?? 'session-456',
      metadata: { correlationId },
      // Keep payload capture minimal; these tests assert the `model` field only.
      captureMessages: 'none',
      captureToolArgs: false,
      captureRequestPayload: false,
      captureRawResponse: false,
      sampleRate: 1,
      maxInputTextBytes: 4096,
      maxOutputTextBytes: 4096,
      maxJsonBytes: 8192
    };

    return { context, exporter };
  }

  function setCoordinatorObservability(coordinator: LLMCoordinator, observability: ObservabilityContext): void {
    // Override the private lazy initializer so we can assert exporter calls deterministically
    // without depending on any observability provider plugin/env config.
    (coordinator as any).createObservabilityContext = jest.fn().mockResolvedValue(observability);
  }

  function setCoordinatorHttpResponse(coordinator: LLMCoordinator, response: any): jest.Mock {
    const llmManager = (coordinator as any).llmManager;
    llmManager.httpClient = { request: jest.fn().mockResolvedValue(response) };
    return llmManager.httpClient.request as jest.Mock;
  }

  test('non-stream: enriches observability model when raw response contains an upstream provider hint', async () => {
    const registry = await createRegistry();
    const coordinator = new LLMCoordinator(registry);

    const { context: observability, exporter } = createStubObservabilityContext({ correlationId: 'nonstream-enrich' });
    setCoordinatorObservability(coordinator, observability);

    setCoordinatorHttpResponse(coordinator, {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        provider: 'upstream-a',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }]
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      settings: { temperature: 0 },
      metadata: { correlationId: 'nonstream-enrich' },
      observability: { enabled: true }
    };

    await coordinator.run(spec);

    const requestArg = exporter.recordLLMRequest.mock.calls[0][0];
    const responseArg = exporter.recordLLMResponse.mock.calls[0][0];
    expect(requestArg.model).toBe('upstream-a/stub-model');
    expect(responseArg.model).toBe('upstream-a/stub-model');

    await coordinator.close();
  });

  test('non-stream: does not enrich observability model when the provider hint matches the configured provider', async () => {
    const registry = await createRegistry();
    const coordinator = new LLMCoordinator(registry);

    const { context: observability, exporter } = createStubObservabilityContext({ correlationId: 'nonstream-no-enrich' });
    setCoordinatorObservability(coordinator, observability);

    setCoordinatorHttpResponse(coordinator, {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        provider: 'test-openai',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }]
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      settings: { temperature: 0 },
      metadata: { correlationId: 'nonstream-no-enrich' },
      observability: { enabled: true }
    };

    await coordinator.run(spec);

    const requestArg = exporter.recordLLMRequest.mock.calls[0][0];
    const responseArg = exporter.recordLLMResponse.mock.calls[0][0];
    expect(requestArg.model).toBe('stub-model');
    expect(responseArg.model).toBe('stub-model');

    await coordinator.close();
  });

  test('non-stream: enriches observability model on HTTP status errors before throwing', async () => {
    const registry = await createRegistry();
    const coordinator = new LLMCoordinator(registry);

    const { context: observability, exporter } = createStubObservabilityContext({ correlationId: 'nonstream-http-error' });
    setCoordinatorObservability(coordinator, observability);

    setCoordinatorHttpResponse(coordinator, {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      data: {
        provider: 'upstream-a',
        error: { message: 'boom' }
      }
    });

    const spec: any = {
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      settings: { temperature: 0 },
      metadata: { correlationId: 'nonstream-http-error' },
      observability: { enabled: true }
    };

    await expect(coordinator.run(spec)).rejects.toThrow();

    const requestArg = exporter.recordLLMRequest.mock.calls[0][0];
    const responseArg = exporter.recordLLMResponse.mock.calls[0][0];
    expect(requestArg.model).toBe('upstream-a/stub-model');
    expect(responseArg.model).toBe('upstream-a/stub-model');

    await coordinator.close();
  });

  test('stream: enriches observability model when an upstream provider hint appears in stream chunks (final response only)', async () => {
    const registry = await createRegistry();
    const coordinator = new LLMCoordinator(registry);

    const { context: observability, exporter } = createStubObservabilityContext({ correlationId: 'stream-enrich' });
    setCoordinatorObservability(coordinator, observability);

    jest.spyOn((coordinator as any).llmManager, 'streamProvider').mockImplementation(async function* () {
      yield {
        provider: 'upstream-a',
        choices: [{ delta: { content: 'hello' } }]
      };
    });

    const spec: any = {
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      settings: { temperature: 0 },
      metadata: { correlationId: 'stream-enrich' },
      observability: { enabled: true }
    };

    for await (const _event of coordinator.runStream(spec)) {
      // consume
    }

    const requestArg = exporter.recordLLMRequest.mock.calls[0][0];
    const responseArg = exporter.recordLLMResponse.mock.calls[0][0];
    expect(requestArg.model).toBe('stub-model');
    expect(responseArg.model).toBe('upstream-a/stub-model');

    await coordinator.close();
  });

  test('stream: does not enrich observability model when the chunk provider hint matches the configured provider', async () => {
    const registry = await createRegistry();
    const coordinator = new LLMCoordinator(registry);

    const { context: observability, exporter } = createStubObservabilityContext({ correlationId: 'stream-no-enrich' });
    setCoordinatorObservability(coordinator, observability);

    jest.spyOn((coordinator as any).llmManager, 'streamProvider').mockImplementation(async function* () {
      yield {
        provider: 'test-openai',
        choices: [{ delta: { content: 'hello' } }]
      };
    });

    const spec: any = {
      llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      settings: { temperature: 0 },
      metadata: { correlationId: 'stream-no-enrich' },
      observability: { enabled: true }
    };

    for await (const _event of coordinator.runStream(spec)) {
      // consume
    }

    const requestArg = exporter.recordLLMRequest.mock.calls[0][0];
    const responseArg = exporter.recordLLMResponse.mock.calls[0][0];
    expect(requestArg.model).toBe('stub-model');
    expect(responseArg.model).toBe('stub-model');

    await coordinator.close();
  });
});

