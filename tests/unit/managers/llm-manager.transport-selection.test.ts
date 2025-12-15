import { describe, expect, jest, test } from '@jest/globals';
import { Readable } from 'stream';
import { LLMManager } from '@/modules/llm/index.ts';
import { Role } from '@/modules/kernel/index.ts';

describe('LLMManager transport selection', () => {
  test('callProvider prefers HTTP when provider has an http(s) endpoint, even if compat exposes callSDK', async () => {
    const compat = {
      callSDK: jest.fn(),
      buildPayload: jest.fn(() => ({ ok: true })),
      parseResponse: jest.fn(() => ({ role: Role.ASSISTANT, content: [] })),
      serializeTools: jest.fn(),
      serializeToolChoice: jest.fn()
    };

    const registry = { getCompatModule: jest.fn().mockReturnValue(compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: {} })
    };
    (manager as any).httpClient = httpClient;

    const provider: any = {
      id: 'provider-http',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'http://example.com/{model}',
        method: 'POST',
        headers: {}
      }
    };

    await manager.callProvider(
      provider,
      'model-x',
      {},
      [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      []
    );

    expect(compat.callSDK).not.toHaveBeenCalled();
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://example.com/model-x' })
    );
  });

  test('callProvider prefers SDK when provider endpoint is not http(s)', async () => {
    const compat = {
      callSDK: jest.fn().mockResolvedValue({ role: Role.ASSISTANT, content: [] })
    };

    const registry = { getCompatModule: jest.fn().mockReturnValue(compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = { request: jest.fn() };
    (manager as any).httpClient = httpClient;

    const provider: any = {
      id: 'provider-sdk',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'SDK_BASED_NOT_USED',
        method: 'POST',
        headers: {}
      }
    };

    await manager.callProvider(
      provider,
      'model-x',
      {},
      [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      []
    );

    expect(compat.callSDK).toHaveBeenCalled();
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  test('streamProvider prefers HTTP when provider has an http(s) endpoint, even if compat exposes streamSDK', async () => {
    const compat = {
      streamSDK: jest.fn(),
      buildPayload: jest.fn(() => ({})),
      getStreamingFlags: jest.fn(() => ({ stream: true })),
      parseResponse: jest.fn(() => ({ role: Role.ASSISTANT, content: [] })),
      serializeTools: jest.fn(),
      serializeToolChoice: jest.fn()
    };

    const registry = { getCompatModule: jest.fn().mockReturnValue(compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockImplementation(async () => {
        const stream = new Readable({ read() {} });
        process.nextTick(() => {
          stream.push(`data: ${JSON.stringify({ ok: true })}\n\n`);
          stream.push('data: [DONE]\n\n');
          stream.push(null);
        });
        return { status: 200, statusText: 'OK', headers: {}, data: stream };
      })
    };
    (manager as any).httpClient = httpClient;

    const provider: any = {
      id: 'provider-http',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'http://example.com/{model}',
        method: 'POST',
        headers: {}
      }
    };

    const iterator = manager.streamProvider(
      provider,
      'model-x',
      {},
      [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      []
    );

    await iterator.next();

    expect(compat.streamSDK).not.toHaveBeenCalled();
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://example.com/model-x' })
    );
  });

  test('streamProvider prefers SDK when provider endpoint is not http(s)', async () => {
    async function* sdkStream() {
      yield { type: 'content_start' };
    }

    const compat = {
      streamSDK: jest.fn().mockReturnValue(sdkStream())
    };

    const registry = { getCompatModule: jest.fn().mockReturnValue(compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = { request: jest.fn() };
    (manager as any).httpClient = httpClient;

    const provider: any = {
      id: 'provider-sdk',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'SDK_BASED_NOT_USED',
        method: 'POST',
        headers: {}
      }
    };

    const iterator = manager.streamProvider(
      provider,
      'model-x',
      {},
      [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }],
      []
    );

    await iterator.next();

    expect(compat.streamSDK).toHaveBeenCalled();
    expect(httpClient.request).not.toHaveBeenCalled();
  });
});

