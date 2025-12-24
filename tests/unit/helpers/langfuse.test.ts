import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('helpers/langfuse', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  test('buildLangfuseAuthHeader builds a Basic auth header from public+secret keys', async () => {
    const { buildLangfuseAuthHeader } = await import('../../helpers/langfuse.ts');
    const header = buildLangfuseAuthHeader({
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test'
    });
    expect(header).toBe(`Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`);
  });

  test('getLangfuseBaseUrl defaults to cloud host and trims trailing slashes', async () => {
    const { getLangfuseBaseUrl } = await import('../../helpers/langfuse.ts');
    expect(getLangfuseBaseUrl({})).toBe('https://cloud.langfuse.com');
    expect(getLangfuseBaseUrl({ LANGFUSE_HOST: 'https://cloud.langfuse.com/' })).toBe(
      'https://cloud.langfuse.com'
    );
  });

  test('attachLangfuseObservability sets observability fields without overriding metadata', async () => {
    const { attachLangfuseObservability } = await import('../../helpers/langfuse.ts');
    const spec = attachLangfuseObservability(
      { messages: [{ role: 'user', content: [] }], metadata: { correlationId: 'corr-1' } } as any,
      'trace-123'
    );
    expect(spec.metadata?.correlationId).toBe('corr-1');
    expect(spec.observability?.enabled).toBe(true);
    expect(spec.observability?.provider).toBe('langfuse');
    expect(spec.observability?.traceId).toBe('trace-123');
    expect(spec.observability?.flushAt).toBe(2);
  });

  test('createTraceId returns an OTLP-valid trace id (32 lowercase hex chars)', async () => {
    const { createTraceId } = await import('../../helpers/langfuse.ts');
    const traceId = createTraceId('unit-seed');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe('0'.repeat(32));
  });

  test('waitForLangfuseTrace polls 404 until ready', async () => {
    const { waitForLangfuseTrace } = await import('../../helpers/langfuse.ts');

    const fetchMock = jest.fn(async () => {
      const calls = fetchMock.mock.calls.length;
      if (calls <= 1) {
        return {
          ok: false,
          status: 404,
          text: async () => 'not found'
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'trace-1', name: 'ok' })
      } as any;
    });

    (globalThis as any).fetch = fetchMock;

    const trace = await waitForLangfuseTrace('trace-1', {
      env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
      timeoutMs: 250,
      minDelayMs: 1,
      maxDelayMs: 5
    });

    expect(trace).toEqual({ id: 'trace-1', name: 'ok' });
    expect(fetchMock).toHaveBeenCalled();
  });

  test('waitForLangfuseTrace times out when trace never appears', async () => {
    const { waitForLangfuseTrace } = await import('../../helpers/langfuse.ts');

    const fetchMock = jest.fn(async () => {
      return {
        ok: false,
        status: 404,
        text: async () => 'not found'
      } as any;
    });
    (globalThis as any).fetch = fetchMock;

    await expect(
      waitForLangfuseTrace('trace-never', {
        env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
        timeoutMs: 30,
        minDelayMs: 5,
        maxDelayMs: 5
      })
    ).rejects.toThrow(/Timed out waiting for Langfuse trace/i);
  });

  test('waitForLangfuseTrace can assert logged observability content (messages/toolCalls)', async () => {
    const traceId = 'trace-123';
    const testFileBase = 'unit-observability';

    await withTempCwd('langfuse-assert-logged-ok', async () => {
      const { logObservabilityEvent } = await import('@/modules/llm/internal/live-test-logger.ts');

      const ctx = { testFile: testFileBase, testName: 'unit', correlationId: traceId };
      logObservabilityEvent(
        {
          eventType: 'LLM_REQUEST',
          traceId,
          generationId: 'gen-1',
          event: {
            traceId,
            provider: 'x',
            model: 'y',
            timestamp: new Date().toISOString(),
            messages: [
              { role: 'system', content: [{ type: 'text', text: 'sys msg' }] },
              { role: 'user', content: [{ type: 'text', text: 'user msg' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'assistant prev' }] },
              {
                role: 'tool',
                content: [{ type: 'tool_result', toolName: 'test.echo', result: { value: 'tool result' } }]
              }
            ]
          }
        },
        ctx
      );

      logObservabilityEvent(
        {
          eventType: 'LLM_RESPONSE',
          traceId,
          generationId: 'gen-1',
          event: {
            traceId,
            provider: 'x',
            model: 'y',
            timestamp: new Date().toISOString(),
            content: [{ type: 'text', text: 'assistant final' }],
            toolCalls: [{ id: 'call-1', name: 'test.echo', arguments: { message: 'abc' } }]
          }
        },
        ctx
      );

      const traceObject = {
        id: traceId,
        input: [
          { role: 'system', content: [{ type: 'text', text: 'sys msg' }] },
          { role: 'user', content: [{ type: 'text', text: 'user msg' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'assistant prev' }] }
        ],
        observations: [
          { metadata: { toolCalls: [{ name: 'test_echo', arguments: { message: 'abc' } }], value: 'tool result' } }
        ],
        output: [{ type: 'text', text: 'assistant final' }]
      };

      const fetchMock = jest.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => traceObject
        } as any;
      });

      (globalThis as any).fetch = fetchMock;

      const { waitForLangfuseTrace } = await import('../../helpers/langfuse.ts');
      const trace = await waitForLangfuseTrace(traceId, {
        env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
        timeoutMs: 250,
        minDelayMs: 1,
        maxDelayMs: 5,
        testFileBase,
        logTimeoutMs: 1000
      });

      expect(trace).toEqual(traceObject);
    });
  });

  test('waitForLangfuseTrace fails when logged observability content is missing from trace', async () => {
    const traceId = 'trace-missing';
    const testFileBase = 'unit-observability-missing';

    await withTempCwd('langfuse-assert-logged-missing', async () => {
      const { logObservabilityEvent } = await import('@/modules/llm/internal/live-test-logger.ts');

      const ctx = { testFile: testFileBase, testName: 'unit', correlationId: traceId };
      logObservabilityEvent(
        {
          eventType: 'LLM_RESPONSE',
          traceId,
          generationId: 'gen-1',
          event: {
            traceId,
            provider: 'x',
            model: 'y',
            timestamp: new Date().toISOString(),
            content: [{ type: 'text', text: 'expected content' }]
          }
        },
        ctx
      );

      const traceObject = { id: traceId, output: [] };
      const fetchMock = jest.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => traceObject
        } as any;
      });
      (globalThis as any).fetch = fetchMock;

      const { waitForLangfuseTrace } = await import('../../helpers/langfuse.ts');
      await expect(
        waitForLangfuseTrace(traceId, {
          env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
          timeoutMs: 100,
          minDelayMs: 1,
          maxDelayMs: 5,
          testFileBase,
          logTimeoutMs: 500
        })
      ).rejects.toThrow(/Langfuse trace missing expected content/i);
    });
  });
});
