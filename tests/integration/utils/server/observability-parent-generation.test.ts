import { jest } from '@jest/globals';
import { PluginRegistry, Role, type ObservabilityContext } from '@/kernel/index.ts';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { createServer } from '@/modules/server/index.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

import { canBindToLocalhost, postJson } from './test-helpers.ts';

let networkAvailable = true;

describe('utils/server (integration) observability parent generation passthrough', () => {
  const originalCwd = process.cwd();

  beforeAll(async () => {
    networkAvailable = await canBindToLocalhost();
    process.chdir(ROOT_DIR);
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('POST /run propagates observability.parentGenerationId to request/response exporter events', async () => {
    if (!networkAvailable) return;

    const exporter = {
      recordLLMRequest: jest.fn().mockReturnValue({ queued: true }),
      recordLLMResponse: jest.fn().mockReturnValue({ queued: true }),
      flush: jest.fn().mockResolvedValue(undefined)
    };

    const observability: ObservabilityContext = {
      exporter: exporter as any,
      traceId: 'trace-server-parent',
      sessionId: 'session-server-parent',
      metadata: { correlationId: 'server-parent-corr' },
      captureMessages: 'none',
      captureToolArgs: false,
      captureRequestPayload: false,
      captureRawResponse: false,
      sampleRate: 1,
      maxInputTextBytes: 4096,
      maxOutputTextBytes: 4096,
      maxJsonBytes: 8192
    };

    const server = await createServer({
      deps: {
        createRegistry: async () => {
          const registry = new PluginRegistry(resolveFixture('plugins', 'basic'));
          await registry.loadAll();
          return registry;
        },
        createCoordinator: async (registry: PluginRegistry) => {
          const coordinator = new LLMCoordinator(registry);
          (coordinator as any).createObservabilityContext = jest.fn().mockResolvedValue(observability);
          const llmManager = (coordinator as any).llmManager;
          llmManager.httpClient = {
            request: jest.fn().mockResolvedValue({
              status: 200,
              statusText: 'OK',
              headers: {},
              data: {
                choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }]
              }
            })
          };
          return coordinator;
        },
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    try {
      const res = await postJson(server.url, '/run', {
        llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
        settings: { temperature: 0 },
        observability: {
          enabled: true,
          parentGenerationId: 'obs-parent'
        },
        metadata: {
          correlationId: 'server-parent-corr',
          generationId: 'gen-child',
          parentGenerationId: 'meta-parent'
        }
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ type: 'response' });

      expect(exporter.recordLLMRequest).toHaveBeenCalledTimes(1);
      expect(exporter.recordLLMResponse).toHaveBeenCalledTimes(1);

      const requestEvent = exporter.recordLLMRequest.mock.calls[0][0];
      const responseEvent = exporter.recordLLMResponse.mock.calls[0][0];

      expect(requestEvent.generationId).toBe('gen-child');
      expect(responseEvent.generationId).toBe('gen-child');
      expect(requestEvent.parentGenerationId).toBe('obs-parent');
      expect(responseEvent.parentGenerationId).toBe('obs-parent');
    } finally {
      await server.close();
    }
  });
});
