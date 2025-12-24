import { jest } from '@jest/globals';

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

  test('attachLangfuseObservability sets metadata.correlationId and observability fields', async () => {
    const { attachLangfuseObservability } = await import('../../helpers/langfuse.ts');
    const spec = attachLangfuseObservability({ messages: [{ role: 'user', content: [] }] } as any, 'trace-123');
    expect(spec.metadata?.correlationId).toBe('trace-123');
    expect(spec.observability?.enabled).toBe(true);
    expect(spec.observability?.provider).toBe('langfuse');
    expect(spec.observability?.traceId).toBe('trace-123');
    expect(spec.observability?.flushAt).toBe(2);
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
});
