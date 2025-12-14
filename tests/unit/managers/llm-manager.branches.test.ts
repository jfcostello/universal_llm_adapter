import { jest } from '@jest/globals';

const loggerStub = () => ({
  info: jest.fn(),
  error: jest.fn(),
  logLLMRequest: jest.fn(),
  logLLMResponse: jest.fn()
});

describe('unit/managers/llm-manager branch coverage', () => {
  test('callProvider wraps non-ProviderExecutionError', async () => {
    const registry = {
      getCompatModule: () => ({
        buildPayload: () => ({}),
        parseResponse: () => ({ provider: 'x', model: 'm', role: 'assistant', content: [] }),
        serializeTools: () => ({}),
        serializeToolChoice: () => ({})
      })
    } as any;

    const { LLMManager } = await import('@/managers/llm-manager.ts');
    const manager = new LLMManager(registry);

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockRejectedValue(new Error('network down'));

    const provider: any = { id: 'p', compat: 'x', endpoint: { urlTemplate: 'https://e/{model}', method: 'POST', headers: {} } };
    await expect(
      manager.callProvider(provider, 'm', {}, [], [], undefined, {}, loggerStub() as any, undefined)
    ).rejects.toMatchObject({ provider: 'p' });

    requestSpy.mockRestore();
  });

  test('logs unconsumed extras for callProvider and streamProvider when logger present', async () => {
    const reg = {
      getCompatModule: () => ({
        buildPayload: () => ({}),
        getStreamingFlags: () => ({}),
        parseResponse: (d: any) => ({ provider: 'p', model: 'm', role: 'assistant', content: [], raw: d }),
        parseStreamChunk: (c: any) => c,
        serializeTools: () => ({}),
        serializeToolChoice: () => ({})
      })
    } as any;

    const { LLMManager } = await import('@/managers/llm-manager.ts');
    const manager = new LLMManager(reg);
    const logger = loggerStub();

    const reqSpy1 = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValueOnce({ status: 200, statusText: 'OK', headers: {}, data: {} })
      .mockResolvedValueOnce({ status: 200, statusText: 'OK', headers: {}, data: { [Symbol.asyncIterator]: async function* () {} } });

    const provider: any = { id: 'p', compat: 'x', endpoint: { urlTemplate: 'https://e/{model}', method: 'POST', headers: {} } };

    await manager.callProvider(provider, 'm', {}, [], [], undefined, { unknown: true } as any, logger as any, undefined);

    const itr = manager.streamProvider(provider, 'm', {}, [], [], undefined, { foo: 'bar' } as any, logger as any);
    await itr.next();

    expect(logger.info).toHaveBeenCalled();

    reqSpy1.mockRestore();
  });

  test('callProvider normalizes toolCalls when present', async () => {
    const reg = {
      getCompatModule: () => ({
        buildPayload: () => ({}),
        parseResponse: () => ({
          provider: 'p',
          model: 'm',
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              id: 'call-1',
              name: 'echo.text',
              args: { text: 'hi' }
            }
          ]
        }),
        serializeTools: () => ({}),
        serializeToolChoice: () => ({})
      })
    } as any;

    const { LLMManager } = await import('@/managers/llm-manager.ts');
    const manager = new LLMManager(reg);

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: {} });

    const provider: any = { id: 'p', compat: 'x', endpoint: { urlTemplate: 'https://e/{model}', method: 'POST', headers: {} } };
    const response = await manager.callProvider(provider, 'm', {}, [], [], undefined, {}, loggerStub() as any, undefined);

    expect(response.toolCalls).toHaveLength(1);
    expect((response.toolCalls![0] as any).args).toEqual({ text: 'hi' });
    expect(response.toolCalls![0].arguments).toEqual({ text: 'hi' });

    requestSpy.mockRestore();
  });
});
