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

  test('disabling keep-alive destroys previously created singleton agents', async () => {
    process.env.LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED = '1';
    const { LLMManager } = await import('@/modules/llm/index.ts');

    const enabledManager = new LLMManager({} as any);
    const previousHttpAgent = (enabledManager as any).httpClient?.defaults?.httpAgent;
    const previousHttpsAgent = (enabledManager as any).httpClient?.defaults?.httpsAgent;

    const destroyHttpSpy = jest.spyOn(previousHttpAgent, 'destroy');
    const destroyHttpsSpy = jest.spyOn(previousHttpsAgent, 'destroy');

    process.env.LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED = '0';
    const disabledManager = new LLMManager({} as any);

    expect(destroyHttpSpy).toHaveBeenCalledTimes(1);
    expect(destroyHttpsSpy).toHaveBeenCalledTimes(1);
    expect((disabledManager as any).httpClient?.defaults?.httpAgent).toBeUndefined();
    expect((disabledManager as any).httpClient?.defaults?.httpsAgent).toBeUndefined();
  });

  test('changing keep-alive socket config replaces and destroys prior singleton agents', async () => {
    process.env.LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED = '1';

    const { getDefaults } = await import('@/kernel/index.ts');
    const defaults = getDefaults();
    defaults.outboundHttp.maxSockets = 16;
    defaults.outboundHttp.maxFreeSockets = 4;

    const { LLMManager } = await import('@/modules/llm/index.ts');
    const firstManager = new LLMManager({} as any);

    const firstHttpAgent = (firstManager as any).httpClient?.defaults?.httpAgent;
    const firstHttpsAgent = (firstManager as any).httpClient?.defaults?.httpsAgent;
    const destroyHttpSpy = jest.spyOn(firstHttpAgent, 'destroy');
    const destroyHttpsSpy = jest.spyOn(firstHttpsAgent, 'destroy');

    defaults.outboundHttp.maxSockets = 32;
    defaults.outboundHttp.maxFreeSockets = 8;

    const secondManager = new LLMManager({} as any);
    const secondHttpAgent = (secondManager as any).httpClient?.defaults?.httpAgent;
    const secondHttpsAgent = (secondManager as any).httpClient?.defaults?.httpsAgent;

    expect(destroyHttpSpy).toHaveBeenCalledTimes(1);
    expect(destroyHttpsSpy).toHaveBeenCalledTimes(1);
    expect(secondHttpAgent).not.toBe(firstHttpAgent);
    expect(secondHttpsAgent).not.toBe(firstHttpsAgent);
    expect(secondHttpAgent.maxSockets).toBe(32);
    expect(secondHttpsAgent.maxSockets).toBe(32);
    expect(secondHttpAgent.maxFreeSockets).toBe(8);
    expect(secondHttpsAgent.maxFreeSockets).toBe(8);
  });
});
