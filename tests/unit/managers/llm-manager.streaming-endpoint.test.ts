import { jest } from '@jest/globals';
import { Readable } from 'stream';

describe('unit/managers/llm-manager streaming endpoint selection', () => {
  test('uses streamingUrlTemplate when provided', async () => {
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

    const provider: any = {
      id: 'google',
      compat: 'google',
      endpoint: {
        urlTemplate: 'https://example.com/v1beta/models/{model}:generateContent',
        streamingUrlTemplate: 'https://example.com/v1beta/models/{model}:streamGenerateContent?alt=sse',
        method: 'POST',
        headers: { 'x-api-key': 'key' }
      }
    };

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockImplementation(async (req: any) => {
        // Simulate SSE stream
        const body = new Readable({ read() {} });
        const emit = (line: any) => body.push(line);
        // one JSON event and then done
        process.nextTick(() => {
          emit(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })}\n\n`);
          emit('data: [DONE]\n\n');
          body.push(null);
        });
        return { status: 200, data: body, headers: {}, statusText: 'OK' };
      });

    const iterator = manager.streamProvider(
      provider,
      'gemini-model',
      {},
      [],
      [],
      undefined,
      {},
      undefined
    );

    // Drain iterator
    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Verify URL chosen for streaming call
    const calledUrl = (requestSpy.mock.calls[0] as any)[0].url;
    expect(calledUrl).toContain(':streamGenerateContent');

    requestSpy.mockRestore();
  });

  test('merges streamingHeaders when present', async () => {
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

    const provider: any = {
      id: 'google',
      compat: 'google',
      endpoint: {
        urlTemplate: 'https://example.com/{model}:generateContent',
        streamingUrlTemplate: 'https://example.com/{model}:streamGenerateContent?alt=sse',
        method: 'POST',
        headers: { 'x-api-key': 'key' },
        streamingHeaders: { 'X-Alt': '1' }
      }
    };

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockImplementation(async (req: any) => {
        const body = new Readable({ read() {} });
        process.nextTick(() => {
          body.push('data: {"candidates": [{"content": {"parts": [{"text": "x"}]}}]}\n\n');
          body.push('data: [DONE]\n\n');
          body.push(null);
        });
        return { status: 200, data: body, headers: {}, statusText: 'OK' };
      });

    const itr = manager.streamProvider(provider, 'gemini', {}, [], [], undefined, {}, undefined);
    await itr.next();
    const headers = (requestSpy.mock.calls[0] as any)[0].headers;
    expect(headers['X-Alt']).toBe('1');

    requestSpy.mockRestore();
  });

  test('streaming error path sets rate-limit flag', async () => {
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

    const provider: any = {
      id: 'google',
      compat: 'google',
      endpoint: {
        urlTemplate: 'https://example.com/{model}:generateContent',
        streamingUrlTemplate: 'https://example.com/{model}:streamGenerateContent?alt=sse',
        method: 'POST',
        headers: {}
      },
      retryWords: ['rate']
    };

    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockImplementation(async (req: any) => {
        const body = new Readable({ read() {} });
        process.nextTick(() => {
          body.push('data: {"error":"rate exceeded"}\n\n');
          body.push(null);
        });
        return { status: 429, data: body, headers: {}, statusText: 'Too Many Requests' };
      });

    const itr = manager.streamProvider(provider, 'gemini', {}, [], [], undefined, {}, undefined);
    await expect(itr.next()).rejects.toMatchObject({ isRateLimit: true });
    requestSpy.mockRestore();
  });

  test('streaming error path without retryWords is not rate-limit', async () => {
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
    const { Readable } = await import('stream');
    const body = new Readable({ read() {} });
    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValue({ status: 500, data: body, headers: {}, statusText: 'ERR' });

    const provider: any = { id: 'p', compat: 'x', endpoint: { urlTemplate: 'https://x/{model}', method: 'POST', headers: {} } };
    const itr = manager.streamProvider(provider, 'm', {}, [], [], undefined, {}, undefined);
    process.nextTick(() => { body.push('data: {"error":"server"}\n'); body.push(null); });
    await expect(itr.next()).rejects.toMatchObject({ isRateLimit: false });
    requestSpy.mockRestore();
  });

  test('SSE parser covers keepalive, blanks, [DONE], invalid JSON, and valid event', async () => {
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

    const { Readable } = await import('stream');
    const stream = new Readable({ read() {} });
    const requestSpy = jest
      .spyOn((manager as any).httpClient, 'request')
      .mockResolvedValue({ status: 200, data: stream, headers: {}, statusText: 'OK' });

    const provider: any = {
      id: 'p',
      compat: 'x',
      endpoint: { urlTemplate: 'https://example.com/{model}', method: 'POST', headers: {} }
    };

    const itr = manager.streamProvider(provider, 'm', {}, [], [], undefined, {}, undefined);

    // Emit various SSE lines
    stream.push(': keepalive\n');
    stream.push('\n');
    stream.push('data: {"bad": [}\n');
    stream.push('data: [DONE]\n');
    stream.push('data: {"ok": 1}\n');
    stream.push(null);

    const chunks: any[] = [];
    for await (const ch of itr) chunks.push(ch);
    expect(chunks).toEqual([{ ok: 1 }]);

    requestSpy.mockRestore();
  });
});
