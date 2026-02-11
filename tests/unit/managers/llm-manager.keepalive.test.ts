import { jest } from '@jest/globals';

describe('unit/managers/llm-manager keep-alive', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('when enabled, creates axios client with http(s) keep-alive agents', async () => {
    process.env.LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED = '1';

    const { LLMManager } = await import('@/modules/llm/index.ts');
    const manager = new LLMManager({} as any);

    const httpAgent = (manager as any).httpClient?.defaults?.httpAgent;
    const httpsAgent = (manager as any).httpClient?.defaults?.httpsAgent;

    expect(httpAgent).toBeDefined();
    expect(httpsAgent).toBeDefined();

    expect((httpAgent as any).options?.keepAlive).toBe(true);
    expect((httpsAgent as any).options?.keepAlive).toBe(true);

    expect((httpAgent as any).maxSockets).toBe(256);
    expect((httpsAgent as any).maxSockets).toBe(256);

    expect((httpAgent as any).maxFreeSockets).toBe(32);
    expect((httpsAgent as any).maxFreeSockets).toBe(32);

    // Ensure idle keep-alive sockets don't keep the process alive.
    const httpFreeListener = ((httpAgent as any).listeners?.('free') ?? []).find(
      (fn: any) => typeof fn === 'function' && fn.name === 'unrefSocketIfPossible'
    );
    const httpsFreeListener = ((httpsAgent as any).listeners?.('free') ?? []).find(
      (fn: any) => typeof fn === 'function' && fn.name === 'unrefSocketIfPossible'
    );
    expect(httpFreeListener).toBeDefined();
    expect(httpsFreeListener).toBeDefined();

    const socketWithUnref = { unref: jest.fn() };
    httpFreeListener(socketWithUnref);
    httpsFreeListener(socketWithUnref);
    expect(socketWithUnref.unref).toHaveBeenCalledTimes(2);

    // Safe no-ops for unexpected socket values.
    httpFreeListener(null);
    httpFreeListener({});
  });

  test('multiple LLMManager instances reuse the same agent singletons when enabled', async () => {
    process.env.LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED = 'true';

    const { LLMManager } = await import('@/modules/llm/index.ts');

    const a = new LLMManager({} as any);
    const b = new LLMManager({} as any);

    const httpAgentA = (a as any).httpClient?.defaults?.httpAgent;
    const httpAgentB = (b as any).httpClient?.defaults?.httpAgent;
    const httpsAgentA = (a as any).httpClient?.defaults?.httpsAgent;
    const httpsAgentB = (b as any).httpClient?.defaults?.httpsAgent;

    expect(httpAgentA).toBeDefined();
    expect(httpAgentB).toBeDefined();
    expect(httpsAgentA).toBeDefined();
    expect(httpsAgentB).toBeDefined();

    expect(httpAgentB).toBe(httpAgentA);
    expect(httpsAgentB).toBe(httpsAgentA);
  });
});
