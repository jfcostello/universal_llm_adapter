import { jest } from '@jest/globals';

describe('unit/managers/llm-manager live logging branches', () => {
  const orig = process.env.LLM_LIVE;
  beforeAll(() => {
    process.env.LLM_LIVE = '1';
  });
  afterAll(() => {
    process.env.LLM_LIVE = orig;
  });

  test('callProvider executes when LLM_LIVE=1 (import guarded)', async () => {
    const registry = {
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
    const manager = new LLMManager(registry);

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: {} });

    const manifest: any = { id: 'p', compat: 'x', endpoint: { urlTemplate: 'https://x/{model}', method: 'POST', headers: {} } };
    await manager.callProvider(manifest, 'm', {}, [], [], undefined, {}, undefined, undefined);
    expect(requestSpy).toHaveBeenCalled();
    requestSpy.mockRestore();
  });

  test('streamProvider executes when LLM_LIVE=1 (import guarded)', async () => {
    const registry = {
      getCompatModule: () => ({
        buildPayload: () => ({}),
        getStreamingFlags: () => ({}),
        parseResponse: (d: any) => d,
        parseStreamChunk: (c: any) => c,
        serializeTools: () => ({}),
        serializeToolChoice: () => ({})
      })
    } as any;

    const { LLMManager } = await import('@/managers/llm-manager.ts');
    const manager = new LLMManager(registry);
    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: { [Symbol.asyncIterator]: async function* () {} } });

    const manifest: any = { id: 'p', compat: 'x', endpoint: { urlTemplate: 'https://x/{model}', method: 'POST', headers: {} } };
    const itr = manager.streamProvider(manifest, 'm', {}, [], [], undefined, {}, undefined);
    // Consume iterator (no chunks)
    const res = await itr.next();
    expect(res.done).toBe(true);
    requestSpy.mockRestore();
  });
});

