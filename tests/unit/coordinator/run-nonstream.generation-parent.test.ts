import { jest } from '@jest/globals';

import { Role } from '@/kernel/index.ts';
import { runNonStream } from '@/modules/llm/internal/llm-coordinator/internal/run-nonstream.ts';

function createLogger() {
  const logger: any = {
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  logger.withCorrelation = jest.fn(() => logger);
  return logger;
}

function createObservabilityContext() {
  return {
    exporter: {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      recordToolExecution: jest.fn(),
      recordSignal: jest.fn(),
      recordTraceUpdate: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined)
    },
    traceId: 'trace-123',
    sessionId: 'session-123',
    metadata: { correlationId: 'corr-123' },
    captureMessages: 'full',
    captureToolArgs: true,
    captureRequestPayload: false,
    captureRawResponse: false,
    sampleRate: 1,
    maxInputTextBytes: 4096,
    maxOutputTextBytes: 4096,
    maxJsonBytes: 8192
  } as any;
}

function createBaseOptions(overrides: Record<string, any> = {}) {
  const logger = createLogger();
  const callProvider = jest.fn().mockResolvedValue({
    provider: 'provider-a',
    model: 'model-a',
    role: Role.ASSISTANT,
    content: [{ type: 'text', text: 'ok' }]
  });

  const handleTools = jest.fn(async (...args: any[]) => args[7]);

  return {
    callProvider,
    handleTools,
    options: {
      spec: {
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
        llmPriority: [{ provider: 'provider-a', model: 'model-a' }],
        settings: {},
        metadata: {
          correlationId: 'corr-123',
          generationId: 'gen-child'
        },
        observability: {
          enabled: true,
          parentGenerationId: 'obs-parent'
        }
      } as any,
      registry: {
        getProvider: jest.fn().mockResolvedValue({ id: 'provider-a', compat: 'mock' })
      } as any,
      llmManager: { callProvider } as any,
      toolCoordinator: { setVectorContexts: jest.fn() } as any,
      getLogger: () => logger,
      applyRuntimeEnvironment: jest.fn().mockResolvedValue(undefined),
      createObservabilityContext: jest.fn().mockResolvedValue(createObservabilityContext()),
      prepareMessages: (spec: any) => spec.messages.slice(),
      shouldInjectVectorContext: () => false,
      shouldCreateVectorTool: () => false,
      ensureVectorContextInjector: jest.fn(),
      ensureToolCoordinator: jest.fn().mockResolvedValue(undefined),
      collectTools: jest.fn().mockResolvedValue([[], [], {}, undefined]),
      attachUsageCostIfNeeded: jest.fn().mockResolvedValue(undefined),
      ensureValidAssistantResponse: jest.fn(),
      handleTools,
      ...overrides
    }
  };
}

describe('runNonStream generation/parent propagation', () => {
  test('uses observability.parentGenerationId (priority over metadata aliases)', async () => {
    const { options, callProvider, handleTools } = createBaseOptions({
      spec: {
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
        llmPriority: [{ provider: 'provider-a', model: 'model-a' }],
        settings: {},
        metadata: {
          correlationId: 'corr-123',
          generationId: 'gen-child',
          parentGenerationId: 'meta-parent'
        },
        observability: {
          enabled: true,
          parentGenerationId: 'obs-parent'
        }
      } as any
    });

    await runNonStream(options as any);

    const callContext = (callProvider as any).mock.calls[0][8];
    const toolLoopContext = (handleTools as any).mock.calls[0][9];
    expect(callContext.generationId).toBe('gen-child');
    expect(callContext.parentGenerationId).toBe('obs-parent');
    expect(toolLoopContext.generationId).toBe('gen-child');
    expect(toolLoopContext.parentGenerationId).toBe('obs-parent');
  });

  test('omits parentGenerationId when it matches generationId', async () => {
    const { options, callProvider, handleTools } = createBaseOptions({
      spec: {
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hello' }] }],
        llmPriority: [{ provider: 'provider-a', model: 'model-a' }],
        settings: {},
        metadata: {
          correlationId: 'corr-123',
          generationId: 'gen-child',
          parentGenerationId: 'gen-child'
        },
        observability: {
          enabled: true
        }
      } as any
    });

    await runNonStream(options as any);

    const callContext = (callProvider as any).mock.calls[0][8];
    const toolLoopContext = (handleTools as any).mock.calls[0][9];
    expect(callContext.generationId).toBe('gen-child');
    expect(callContext.parentGenerationId).toBeUndefined();
    expect(toolLoopContext.parentGenerationId).toBeUndefined();
  });
});
