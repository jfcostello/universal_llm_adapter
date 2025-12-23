import { jest } from '@jest/globals';

function createMockLogger() {
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
  return logger;
}

describe('modules/observability', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('calculateBackoffDelay', () => {
    test('returns base delay for first attempt', async () => {
      const { calculateBackoffDelay } = await import('@/modules/observability/index.ts');

      // With jitter, result should be between baseDelay * 0.75 and baseDelay * 1.25
      const delay = calculateBackoffDelay(0, 250, 30000);
      expect(delay).toBeGreaterThanOrEqual(187); // 250 * 0.75 (floored)
      expect(delay).toBeLessThanOrEqual(312); // 250 * 1.25 (floored, jitter < 1.25)
    });

    test('increases exponentially with attempts', async () => {
      const { calculateBackoffDelay } = await import('@/modules/observability/index.ts');

      // Attempt 1: base * 2 = 500ms (with jitter: 375-625)
      const delay1 = calculateBackoffDelay(1, 250, 30000);
      expect(delay1).toBeGreaterThanOrEqual(375);
      expect(delay1).toBeLessThanOrEqual(625);

      // Attempt 2: base * 4 = 1000ms (with jitter: 750-1250)
      const delay2 = calculateBackoffDelay(2, 250, 30000);
      expect(delay2).toBeGreaterThanOrEqual(750);
      expect(delay2).toBeLessThanOrEqual(1250);
    });

    test('caps at max delay', async () => {
      const { calculateBackoffDelay } = await import('@/modules/observability/index.ts');

      // Very high attempt should be capped at maxDelay (with jitter: maxDelay * 0.75 to maxDelay * 1.25)
      const delay = calculateBackoffDelay(20, 250, 1000);
      expect(delay).toBeGreaterThanOrEqual(750); // 1000 * 0.75
      expect(delay).toBeLessThanOrEqual(1250); // 1000 * 1.25
    });
  });

  describe('sleep', () => {
    test('waits for specified duration', async () => {
      const { sleep } = await import('@/modules/observability/index.ts');

      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });
  });

  describe('getNoopObservabilityDeps', () => {
    test('returns noop deps that are disabled', async () => {
      const { getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = getNoopObservabilityDeps();

      expect(deps.isEnabled()).toBe(false);
    });

    test('returns noop exporter', async () => {
      const { getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = getNoopObservabilityDeps();
      const exporter = deps.getExporter();

      expect(typeof exporter.recordLLMRequest).toBe('function');
      expect(typeof exporter.recordLLMResponse).toBe('function');
      expect(typeof exporter.flush).toBe('function');
      expect(typeof exporter.shutdown).toBe('function');
    });

    test('noop exporter recordLLMRequest returns disabled result', async () => {
      const { getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = getNoopObservabilityDeps();
      const exporter = deps.getExporter();

      const result = exporter.recordLLMRequest({
        traceId: 'test',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test',
        messages: []
      });

      expect(result.queued).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    test('noop exporter recordLLMResponse returns disabled result', async () => {
      const { getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = getNoopObservabilityDeps();
      const exporter = deps.getExporter();

      const result = exporter.recordLLMResponse({
        traceId: 'test',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test',
        content: 'test response'
      });

      expect(result.queued).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    test('noop exporter flush and shutdown are no-ops', async () => {
      const { getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = getNoopObservabilityDeps();
      const exporter = deps.getExporter();

      await expect(exporter.flush()).resolves.toBeUndefined();
      await expect(exporter.shutdown()).resolves.toBeUndefined();
    });

    test('shutdown clears cached noop exporter', async () => {
      const { getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = getNoopObservabilityDeps();

      const exporter1 = deps.getExporter();
      await deps.shutdown();
      const exporter2 = deps.getExporter();

      // After shutdown, a new instance should be created
      expect(exporter1).not.toBe(exporter2);
    });
  });

  describe('resolveObservabilityDeps', () => {
    test('returns noop deps when no overrides provided', async () => {
      const { resolveObservabilityDeps } = await import('@/modules/observability/index.ts');
      const deps = resolveObservabilityDeps();

      expect(deps.isEnabled()).toBe(false);
    });

    test('uses provided overrides', async () => {
      const { resolveObservabilityDeps } = await import('@/modules/observability/index.ts');

      const customShutdown = jest.fn(async () => {});

      const deps = resolveObservabilityDeps({
        isEnabled: () => true,
        shutdown: customShutdown
      });

      expect(deps.isEnabled()).toBe(true);

      await deps.shutdown();
      expect(customShutdown).toHaveBeenCalled();
    });

    test('fills in noop for missing overrides', async () => {
      const { resolveObservabilityDeps, getNoopObservabilityDeps } = await import('@/modules/observability/index.ts');

      const deps = resolveObservabilityDeps({
        isEnabled: () => true
        // getExporter and shutdown not provided
      });

      expect(deps.isEnabled()).toBe(true);
      // Should use noop for missing
      expect(deps.getExporter()).toBe(getNoopObservabilityDeps().getExporter());
    });
  });

  describe('ObservabilityExporter', () => {
    test('records LLM response events', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      const result = exporter.recordLLMResponse({
        traceId: 'trace-1',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test-model',
        content: [{ type: 'text', text: 'Hello' }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        durationMs: 100
      });

      expect(result.queued).toBe(true);
      expect(result.eventId).toBeDefined();

      await exporter.shutdown();
    });

    test('logs export success when LLM_LIVE=1', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');
      const originalLive = process.env.LLM_LIVE;
      process.env.LLM_LIVE = '1';

      try {
        const logger = createMockLogger();
        const mockCompat = {
          buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
          sendBatch: jest.fn(async () => ({ success: true, outcomes: [{ envelopeId: 'x', success: true }] }))
        };

        const mockManifest = {
          id: 'test',
          compat: 'test',
          endpoint: { urlTemplate: 'http://test', method: 'POST' }
        };

        const exporter = new ObservabilityExporter(
          {
            provider: 'test',
            logger,
            flushAt: 1,
            flushIntervalMs: 60000,
            maxQueueSize: 1000,
            maxAttempts: 1,
            baseDelayMs: 250,
            maxDelayMs: 30000,
            timeoutMs: 10000
          },
          mockCompat as any,
          mockManifest as any
        );

        exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
        await exporter.flush();

        expect(logger.info).toHaveBeenCalledWith(
          'Observability batch export succeeded',
          expect.objectContaining({ provider: 'test', events: 1, envelopes: 1 })
        );

        await exporter.shutdown();
      } finally {
        if (originalLive === undefined) {
          delete process.env.LLM_LIVE;
        } else {
          process.env.LLM_LIVE = originalLive;
        }
      }
    });

    test('unrefs the periodic flush timer when supported', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const unref = jest.fn();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((() => ({ unref })) as any);
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout').mockImplementation((() => {}) as any);

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      expect(unref).toHaveBeenCalledTimes(1);

      await exporter.shutdown();

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    test('flush on empty queue is a no-op', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      // Flush empty queue
      await exporter.flush();

      // Should not have called buildBatch or sendBatch
      expect(mockCompat.buildBatch).not.toHaveBeenCalled();
      expect(mockCompat.sendBatch).not.toHaveBeenCalled();

      await exporter.shutdown();
    });

    test('passes providerConfig through to compat build/send methods', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const providerConfig = { baseUrl: 'https://override.langfuse.com' };

      const mockCompat = {
        buildBatch: jest.fn(() => ({
          payload: {},
          eventIndexByEnvelopeId: new Map<string, number>([['envelope-0', 0]])
        })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          providerConfig,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      await exporter.flush();

      expect(mockCompat.buildBatch).toHaveBeenCalledWith(
        expect.any(Array),
        mockManifest,
        expect.objectContaining({ providerConfig, timeoutMs: 10000, eventIds: expect.any(Array) })
      );
      expect(mockCompat.sendBatch).toHaveBeenCalledWith(
        {},
        mockManifest,
        expect.objectContaining({ providerConfig, timeoutMs: 10000, eventIds: expect.any(Array) })
      );

      await exporter.shutdown();
    });

    test('splits batches when provider maxBatchBytes is exceeded', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const chunkBytes = 100;
      const oneBytes = Buffer.byteLength(JSON.stringify({ data: 'x'.repeat(chunkBytes) }), 'utf8');
      const twoBytes = Buffer.byteLength(JSON.stringify({ data: 'x'.repeat(chunkBytes * 2) }), 'utf8');
      const maxBatchBytes = Math.floor((oneBytes + twoBytes) / 2);

      const mockCompat = {
        buildBatch: jest.fn((events: unknown[]) => ({
          payload: { data: 'x'.repeat((events.length || 1) * chunkBytes) },
          eventIndexByEnvelopeId: new Map()
        })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' },
        limits: { maxBatchBytes }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 1,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      exporter.recordLLMResponse({ traceId: 'trace-1', timestamp: '', provider: '', model: '', content: [] });

      await exporter.shutdown();

      // 2 events doesn't fit, so it should be split into 2 single-event batches
      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(2);
    });

    test('drops a single event when it cannot fit provider maxBatchBytes', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockCompat = {
        buildBatch: jest.fn(() => ({
          payload: { data: 'x'.repeat(200) },
          eventIndexByEnvelopeId: new Map()
        })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' },
        limits: { maxBatchBytes: 50 }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 1,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      const record = exporter.recordLLMRequest({
        traceId: 'trace-1',
        timestamp: '',
        provider: '',
        model: '',
        messages: []
      });

      await exporter.shutdown();

      expect(mockCompat.sendBatch).not.toHaveBeenCalled();
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability event exceeds maxBatchBytes; dropping event',
        expect.objectContaining({
          provider: 'test',
          eventId: record.eventId,
          maxBatchBytes: 50
        })
      );
    });

    test('warns when max attempts exceeded', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => {
          throw new Error('Network error');
        })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 2, // Low attempts for fast test
          baseDelayMs: 10,
          maxDelayMs: 20,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });

      await exporter.flush();

      // Should warn about failed exports
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability batch export failed',
        expect.objectContaining({
          provider: 'test',
          attempt: 1,
          maxAttempts: 2,
          error: 'Network error'
        })
      );
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability export failed after max attempts',
        expect.objectContaining({
          provider: 'test',
          failedEvents: 1,
          maxAttempts: 2
        })
      );
      await exporter.shutdown();
    });

    test('logs non-Error thrown values on batch export failure', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => {
          throw undefined;
        })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 1,
          baseDelayMs: 10,
          maxDelayMs: 20,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      await exporter.flush();

      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability batch export failed',
        expect.objectContaining({
          provider: 'test',
          error: 'undefined'
        })
      );

      await exporter.shutdown();
    });

    test('flushes on timer interval', async () => {
      jest.useFakeTimers();

      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100, // High threshold so timer-based flush triggers first
          flushIntervalMs: 1000, // 1 second interval
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      // Add event but don't reach flushAt threshold
      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });

      expect(mockCompat.sendBatch).not.toHaveBeenCalled();

      // Advance timer to trigger flush
      jest.advanceTimersByTime(1000);

      // Wait for async operations
      await Promise.resolve();
      await Promise.resolve();

      expect(mockCompat.sendBatch).toHaveBeenCalled();

      jest.useRealTimers();
      await exporter.shutdown();
    });

    test('does not restart timer when shutdown is called during flush', async () => {
      jest.useFakeTimers();

      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      let exporterRef: any;
      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => {
          // Call shutdown from within sendBatch to simulate shutdown during flush
          // This sets shuttingDown = true before startFlushTimer is called
          exporterRef.shutdown();
          return { success: true, outcomes: [] };
        })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 1000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );
      exporterRef = exporter;

      // Add event
      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });

      // Advance timer to trigger flush - this will call sendBatch which calls shutdown
      jest.advanceTimersByTime(1000);

      // Wait for async operations
      await Promise.resolve();
      await Promise.resolve();

      // sendBatch should have been called
      expect(mockCompat.sendBatch).toHaveBeenCalled();

      // Advance timer again - should not trigger another flush since shutdown was called
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // sendBatch should still only have been called once
      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    test('queues events and returns event ID', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      const result = exporter.recordLLMRequest({
        traceId: 'trace-1',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test-model',
        messages: []
      });

      expect(result.queued).toBe(true);
      expect(result.eventId).toBeDefined();
      expect(result.eventId.length).toBeGreaterThan(0);

      await exporter.shutdown();
    });

    test('flushes when queue reaches flushAt threshold', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 2, // Flush after 2 events
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      // Add first event - should not trigger flush
      exporter.recordLLMRequest({
        traceId: 'trace-1',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test-model',
        messages: []
      });

      expect(mockCompat.sendBatch).not.toHaveBeenCalled();

      // Add second event - should trigger flush
      exporter.recordLLMRequest({
        traceId: 'trace-2',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test-model',
        messages: []
      });

      // Wait for async flush
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCompat.buildBatch).toHaveBeenCalled();
      expect(mockCompat.sendBatch).toHaveBeenCalled();

      await exporter.shutdown();
    });

    test('drops oldest events when queue is full', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100, // High threshold to prevent auto-flush
          flushIntervalMs: 60000,
          maxQueueSize: 2, // Very small queue
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      // Fill the queue
      const oldest = exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      exporter.recordLLMRequest({ traceId: 'trace-2', timestamp: '', provider: '', model: '', messages: [] });

      // This should drop the oldest
      exporter.recordLLMRequest({ traceId: 'trace-3', timestamp: '', provider: '', model: '', messages: [] });

      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability queue full; dropped oldest event',
        expect.objectContaining({
          provider: 'test',
          droppedEventId: oldest.eventId,
          maxQueueSize: 2
        })
      );
      await exporter.shutdown();
    });

    test('retries on failure with backoff', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      let callCount = 0;
      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => {
          callCount++;
          if (callCount < 3) {
            throw new Error('Network error');
          }
          return { success: true, outcomes: [] };
        })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const mockLogger = createMockLogger();

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 5,
          baseDelayMs: 10, // Short delay for tests
          maxDelayMs: 50,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });

      await exporter.flush();

      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(3);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability batch export failed',
        expect.objectContaining({
          provider: 'test',
          attempt: 1,
          maxAttempts: 5,
          error: 'Network error'
        })
      );
      await exporter.shutdown();
    });

    test('rejects events after shutdown', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      await exporter.shutdown();

      const result = exporter.recordLLMRequest({
        traceId: 'trace-1',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'test-model',
        messages: []
      });

      expect(result.queued).toBe(false);
      expect(result.reason).toBe('shutdown');
    });

    test('handles partial success with retryable outcomes', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn((events: unknown[]) => {
          const eventIndexByEnvelopeId = new Map<string, number>();
          for (let index = 0; index < events.length; index++) {
            eventIndexByEnvelopeId.set(`envelope-${index}`, index);
          }
          return { payload: {}, eventIndexByEnvelopeId };
        }),
        sendBatch: jest.fn()
          .mockResolvedValueOnce({
            success: false,
            outcomes: [
              { envelopeId: 'envelope-0', success: false, retryable: true } // Retryable
            ]
          })
          .mockResolvedValueOnce({
            success: true,
            outcomes: [
              { envelopeId: 'envelope-0', success: true }
            ]
          })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const mockLogger = createMockLogger();

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 50,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });

      await exporter.flush();

      // Should have retried the retryable event
      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(2);

      await exporter.shutdown();
    });

    test('retries all events when a retryable outcome cannot be mapped to an event index', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })), // Intentionally empty map
        sendBatch: jest.fn()
          .mockResolvedValueOnce({
            success: false,
            outcomes: [{ envelopeId: 'unknown-envelope', success: false, retryable: true }]
          })
          .mockResolvedValueOnce({
            success: true,
            outcomes: []
          })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          logger: mockLogger,
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      exporter.recordLLMRequest({ traceId: 'trace-2', timestamp: '', provider: '', model: '', messages: [] });

      await exporter.flush();

      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(2);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability retryable outcomes unmapped; retrying all events',
        expect.objectContaining({
          provider: 'test'
        })
      );
      await exporter.shutdown();
    });

    test('handles partial success with non-retryable outcomes', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({
          success: false,
          outcomes: [
            { envelopeId: 'envelope-0', success: true },
            { envelopeId: 'envelope-1', success: false, retryable: false } // Not retryable
          ]
        }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 50,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      exporter.recordLLMRequest({ traceId: 'trace-2', timestamp: '', provider: '', model: '', messages: [] });

      await exporter.flush();

      // Non-retryable failures should not be retried
      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(1);

      await exporter.shutdown();
    });

    test('flush is idempotent when already flushing', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      let resolveFlush: () => void;
      const flushPromise = new Promise<void>(resolve => { resolveFlush = resolve; });

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => {
          await flushPromise;
          return { success: true, outcomes: [] };
        })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
          flushAt: 100,
          flushIntervalMs: 60000,
          maxQueueSize: 1000,
          maxAttempts: 3,
          baseDelayMs: 250,
          maxDelayMs: 30000,
          timeoutMs: 10000
        },
        mockCompat as any,
        mockManifest as any
      );

      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });

      // Start first flush
      const flush1 = exporter.flush();

      // Start second flush while first is in progress
      const flush2 = exporter.flush();

      // Both should resolve to the same operation
      resolveFlush!();

      await Promise.all([flush1, flush2]);

      // Only one batch should have been sent
      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(1);

      await exporter.shutdown();
    });
  });

  describe('createObservabilityDeps', () => {
    test('returns noop deps when observability is disabled', async () => {
      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      // Mock registry that should not be called
      const mockRegistry = {
        getObservabilityProvider: jest.fn(),
        getObservabilityCompat: jest.fn()
      };

      const deps = await createObservabilityDeps(mockRegistry as any, { enabled: false });

      expect(deps.isEnabled()).toBe(false);
      expect(mockRegistry.getObservabilityProvider).not.toHaveBeenCalled();
    });

    test('returns noop deps when spec is undefined and defaults have observability disabled', async () => {
      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      // Mock registry that should not be called
      const mockRegistry = {
        getObservabilityProvider: jest.fn(),
        getObservabilityCompat: jest.fn()
      };

      // Call without spec - uses defaults which have observability disabled by default
      const deps = await createObservabilityDeps(mockRegistry as any);

      expect(deps.isEnabled()).toBe(false);
      expect(mockRegistry.getObservabilityProvider).not.toHaveBeenCalled();
    });

    test('returns noop deps when no provider specified in spec or defaults', async () => {
      // This test needs to mock getDefaults to return no provider
      jest.resetModules();

      // Mock the kernel module to return defaults with no provider
      jest.unstable_mockModule('@/modules/kernel/index.ts', () => ({
        getNoopObservabilityDeps: () => ({
          isEnabled: () => false,
          getExporter: () => ({
            recordLLMRequest: () => ({ eventId: '', queued: false, reason: 'disabled' }),
            recordLLMResponse: () => ({ eventId: '', queued: false, reason: 'disabled' }),
            flush: async () => {},
            shutdown: async () => {}
          }),
          shutdown: async () => {}
        }),
        resolveObservabilityDeps: (overrides: any = {}) => ({
          isEnabled: overrides.isEnabled ?? (() => false),
          getExporter: overrides.getExporter ?? (() => ({})),
          shutdown: overrides.shutdown ?? (async () => {})
        }),
        getDefaults: () => ({
          observability: {
            enabled: true,
            provider: undefined, // No provider in defaults
            flushAt: 10,
            flushIntervalMs: 5000,
            maxQueueSize: 1000,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 30000,
            timeoutMs: 10000
          }
        }),
        getNoopLogger: () => createMockLogger()
      }));

      const mockLogger = createMockLogger();

      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      const mockRegistry = {
        getObservabilityProvider: jest.fn(),
        getObservabilityCompat: jest.fn()
      };

      // Enable observability but don't specify a provider in spec
      // Defaults also have no provider, so resolveConfig should return null
      const deps = await createObservabilityDeps(mockRegistry as any, {
        enabled: true
        // No provider in spec
      }, mockLogger as any);

      // Should have warned about no provider
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability disabled: no provider configured',
        expect.any(Object)
      );
      expect(deps.isEnabled()).toBe(false);

      jest.resetModules();
    });

    test('returns noop deps when provider fails to load', async () => {
      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockRegistry = {
        getObservabilityProvider: jest.fn(async () => {
          throw new Error('Provider not found');
        }),
        getObservabilityCompat: jest.fn()
      };

      const deps = await createObservabilityDeps(mockRegistry as any, {
        enabled: true,
        provider: 'nonexistent'
      }, mockLogger as any);

      expect(deps.isEnabled()).toBe(false);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability failed to initialize',
        expect.objectContaining({
          provider: 'nonexistent',
          error: 'Provider not found'
        })
      );
    });

    test('logs non-Error thrown values when provider fails to load', async () => {
      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');
      const mockLogger = createMockLogger();

      const mockRegistry = {
        getObservabilityProvider: jest.fn(async () => {
          throw undefined;
        }),
        getObservabilityCompat: jest.fn()
      };

      const deps = await createObservabilityDeps(mockRegistry as any, {
        enabled: true,
        provider: 'nonexistent'
      }, mockLogger as any);

      expect(deps.isEnabled()).toBe(false);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Observability failed to initialize',
        expect.objectContaining({
          provider: 'nonexistent',
          error: 'undefined'
        })
      );
    });

    test('creates working deps when provider loads successfully', async () => {
      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test-compat',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const mockRegistry = {
        getObservabilityProvider: jest.fn(async () => mockManifest),
        getObservabilityCompat: jest.fn(async () => mockCompat)
      };

      const deps = await createObservabilityDeps(mockRegistry as any, {
        enabled: true,
        provider: 'test'
      });

      expect(deps.isEnabled()).toBe(true);

      const exporter = deps.getExporter();
      const result = exporter.recordLLMRequest({
        traceId: 'trace-1',
        timestamp: new Date().toISOString(),
        provider: 'test',
        model: 'model',
        messages: []
      });

      expect(result.queued).toBe(true);

      await deps.shutdown();
    });
  });
});
