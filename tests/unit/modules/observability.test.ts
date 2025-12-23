import { jest } from '@jest/globals';

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

      // With jitter, result should be between baseDelay * 0.5 and baseDelay * 1.5
      const delay = calculateBackoffDelay(0, 250, 30000);
      expect(delay).toBeGreaterThanOrEqual(125); // 250 * 0.5
      expect(delay).toBeLessThanOrEqual(375); // 250 * 1.5
    });

    test('increases exponentially with attempts', async () => {
      const { calculateBackoffDelay } = await import('@/modules/observability/index.ts');

      // Attempt 1: base * 2 = 500ms (with jitter: 250-750)
      const delay1 = calculateBackoffDelay(1, 250, 30000);
      expect(delay1).toBeGreaterThanOrEqual(250);
      expect(delay1).toBeLessThanOrEqual(750);

      // Attempt 2: base * 4 = 1000ms (with jitter: 500-1500)
      const delay2 = calculateBackoffDelay(2, 250, 30000);
      expect(delay2).toBeGreaterThanOrEqual(500);
      expect(delay2).toBeLessThanOrEqual(1500);
    });

    test('caps at max delay', async () => {
      const { calculateBackoffDelay } = await import('@/modules/observability/index.ts');

      // Very high attempt should be capped at maxDelay (with jitter: maxDelay * 0.5 to maxDelay * 1.5)
      const delay = calculateBackoffDelay(20, 250, 1000);
      expect(delay).toBeGreaterThanOrEqual(500); // 1000 * 0.5
      expect(delay).toBeLessThanOrEqual(1500); // 1000 * 1.5
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

    test('warns when max attempts exceeded', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to export'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('after 2 attempts'));

      warnSpy.mockRestore();
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

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
      exporter.recordLLMRequest({ traceId: 'trace-1', timestamp: '', provider: '', model: '', messages: [] });
      exporter.recordLLMRequest({ traceId: 'trace-2', timestamp: '', provider: '', model: '', messages: [] });

      // This should drop the oldest
      exporter.recordLLMRequest({ traceId: 'trace-3', timestamp: '', provider: '', model: '', messages: [] });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Queue full'));

      warnSpy.mockRestore();
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

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const exporter = new ObservabilityExporter(
        {
          provider: 'test',
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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Batch export failed'));

      warnSpy.mockRestore();
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

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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

      await exporter.flush();

      // Should have retried the retryable event
      expect(mockCompat.sendBatch).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      await exporter.shutdown();
    });

    test('retries all events when a retryable outcome cannot be mapped to an event index', async () => {
      const { ObservabilityExporter } = await import('@/modules/observability/index.ts');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
      expect(warnSpy).toHaveBeenCalledWith(
        '[observability] Retryable envelope outcome could not be mapped to an event index; retrying all events'
      );

      warnSpy.mockRestore();
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
        })
      }));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
      });

      // Should have warned about no provider
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No provider specified'));
      expect(deps.isEnabled()).toBe(false);

      warnSpy.mockRestore();
      jest.resetModules();
    });

    test('returns noop deps when provider fails to load', async () => {
      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const mockRegistry = {
        getObservabilityProvider: jest.fn(async () => {
          throw new Error('Provider not found');
        }),
        getObservabilityCompat: jest.fn()
      };

      const deps = await createObservabilityDeps(mockRegistry as any, {
        enabled: true,
        provider: 'nonexistent'
      });

      expect(deps.isEnabled()).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize'));

      warnSpy.mockRestore();
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
