import { jest, describe, test, expect } from '@jest/globals';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { Role } from '@/modules/kernel/index.ts';

describe('LLMCoordinator observability lifecycle', () => {
  test('close triggers observability shutdown to flush small queues', async () => {
    const buildBatch = jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() }));
    const sendBatch = jest.fn(async () => ({ success: true, outcomes: [] }));

    const registry = {
      getProvider: jest.fn(),
      getCompatModule: jest.fn(),
      getMCPServers: jest.fn().mockResolvedValue([]),
      getProcessRoutes: jest.fn().mockResolvedValue([]),
      getTool: jest.fn().mockResolvedValue(null),
      getObservabilityProvider: jest.fn().mockResolvedValue({
        id: 'langfuse',
        compat: 'langfuse',
        endpoint: { urlTemplate: 'http://example', method: 'POST' }
      }),
      getObservabilityCompat: jest.fn().mockResolvedValue({
        buildBatch,
        sendBatch
      })
    } as any;

    const coordinator = new LLMCoordinator(registry);

    const spec: any = {
      messages: [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: [{ provider: 'test-provider', model: 'test-model' }],
      settings: {},
      observability: {
        enabled: true,
        provider: 'langfuse',
        flushAt: 100,
        flushIntervalMs: 60000
      },
      metadata: { correlationId: 'corr-1' }
    };

    const ctx = await (coordinator as any).createObservabilityContext(spec, {});
    expect(ctx).toBeDefined();

    ctx.exporter.recordLLMRequest({
      traceId: ctx.traceId,
      timestamp: new Date().toISOString(),
      provider: 'test-provider',
      model: 'test-model',
      messages: []
    });

    ctx.exporter.recordLLMResponse({
      traceId: ctx.traceId,
      timestamp: new Date().toISOString(),
      provider: 'test-provider',
      model: 'test-model',
      content: []
    });

    expect(sendBatch).not.toHaveBeenCalled();

    await coordinator.close();
    await new Promise(resolve => setImmediate(resolve));

    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  test('close swallows observability shutdown failures', async () => {
    const logger: any = {
      withCorrelation: () => logger,
      debug: jest.fn(),
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn(),
      close: jest.fn(async () => {})
    };

    const coordinator = new LLMCoordinator({} as any, {
      logging: {
        getLogger: () => logger
      }
    });
    (coordinator as any).observabilityShutdownHooks = [() => Promise.reject(undefined)];

    await coordinator.close();
    await new Promise(resolve => setImmediate(resolve));

    expect(logger.warning).toHaveBeenCalledWith(
      'Observability shutdown failed',
      expect.objectContaining({ error: 'undefined' })
    );
  });
});
