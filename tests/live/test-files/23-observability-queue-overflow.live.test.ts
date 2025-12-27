import { jest } from '@jest/globals';
import { ObservabilityExporter } from '@/modules/observability/index.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '23-observability-queue-overflow';

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('queue overflow drops oldest events safely', async () => {
    const warnings: any[] = [];
    const logger: any = {
      info: jest.fn(),
      warning: jest.fn((msg: string, data: any) => warnings.push({ msg, data })),
      error: jest.fn(),
      debug: jest.fn()
    };

    const buildBatch = jest.fn((events: any[], _manifest: any, context?: any) => {
      const ids = Array.isArray(context?.eventIds) ? context.eventIds.map(String) : events.map((_e, i) => `env-${i}`);
      const map = new Map<string, number>();
      ids.forEach((id, i) => map.set(id, i));
      return { payload: { count: events.length }, eventIndexByEnvelopeId: map };
    });

    const sendBatch = jest.fn(async (_payload: any, _manifest: any, context?: any) => {
      const ids = Array.isArray(context?.eventIds) ? context.eventIds.map(String) : [];
      return {
        success: true,
        outcomes: ids.map((id) => ({ envelopeId: id, success: true }))
      };
    });

    const compat: any = { buildBatch, sendBatch };
    const manifest: any = {
      id: 'test-observability',
      compat: 'test',
      endpoint: { urlTemplate: 'http://localhost/otel', method: 'POST', headers: {} }
    };

    const exporter = new ObservabilityExporter(
      {
        provider: 'test-observability',
        logger,
        flushAt: 1000, // never auto-flush during the enqueue storm
        flushIntervalMs: 60_000,
        maxQueueSize: 3,
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1,
        maxAttributeValueBytes: 1024
      },
      compat,
      manifest
    );

    for (let i = 0; i < 10; i++) {
      exporter.recordLLMRequest({
        traceId: `t${i}`,
        generationId: `g${i}`,
        timestampMs: Date.now(),
        provider: 'p',
        model: 'm',
        messages: [],
        settings: {},
        tools: []
      } as any);
    }

    await exporter.flush();

    // Only the last maxQueueSize events should remain.
    expect(buildBatch).toHaveBeenCalled();
    const lastBuildArgs = buildBatch.mock.calls[buildBatch.mock.calls.length - 1]?.[0] as any[];
    const traceIds = lastBuildArgs.map(e => String(e.traceId));
    expect(traceIds).toEqual(['t7', 't8', 't9']);

    expect(warnings.some(w => w.msg === 'Observability queue full; dropped oldest event')).toBe(true);

    await exporter.shutdown();
  });
});

