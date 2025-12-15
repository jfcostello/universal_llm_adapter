import { describe, expect, jest, test } from '@jest/globals';
import { Readable } from 'stream';
import { LLMManager } from '@/modules/llm/index.ts';
import { Role } from '@/modules/kernel/index.ts';
import { aggregateSystemMessages } from '@/modules/messages/index.ts';

describe('LLMManager message normalization', () => {
  test('callProvider aggregates system messages for both SDK and HTTP paths', async () => {
    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'First' }] },
      { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'Second' }] },
      { role: Role.USER, content: [{ type: 'text' as const, text: 'Hi' }] }
    ];

    const expected = aggregateSystemMessages(messages as any);

    const providerSdk: any = {
      id: 'test-provider-sdk',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'SDK_BASED_NOT_USED',
        method: 'POST',
        headers: {}
      }
    };

    const providerHttp: any = {
      id: 'test-provider-http',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'http://service/{model}',
        method: 'POST',
        headers: {}
      }
    };

    const sdkCompat = {
      callSDK: jest.fn().mockResolvedValue({ role: Role.ASSISTANT, content: [] })
    };

    const sdkRegistry = {
      getCompatModule: jest.fn().mockReturnValue(sdkCompat)
    } as any;

    const sdkManager = new LLMManager(sdkRegistry);
    await sdkManager.callProvider(providerSdk, 'model-x', {}, messages as any, []);

    expect(sdkCompat.callSDK).toHaveBeenCalled();
    expect(sdkCompat.callSDK.mock.calls[0][2]).toEqual(expected);

    const httpCompat = {
      buildPayload: jest.fn(() => ({})),
      parseResponse: jest.fn(() => ({ role: Role.ASSISTANT, content: [] })),
      getStreamingFlags: jest.fn(() => ({})),
      serializeTools: jest.fn(),
      serializeToolChoice: jest.fn()
    };

    const httpRegistry = {
      getCompatModule: jest.fn().mockReturnValue(httpCompat)
    } as any;

    const httpManager = new LLMManager(httpRegistry);
    (httpManager as any).httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: {} })
    };

    await httpManager.callProvider(providerHttp, 'model-x', {}, messages as any, []);

    expect(httpCompat.buildPayload).toHaveBeenCalled();
    expect(httpCompat.buildPayload.mock.calls[0][2]).toEqual(expected);
  });

  test('streamProvider aggregates system messages for both SDK and HTTP paths', async () => {
    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'First' }] },
      { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'Second' }] },
      { role: Role.USER, content: [{ type: 'text' as const, text: 'Hi' }] }
    ];

    const expected = aggregateSystemMessages(messages as any);

    const providerSdk: any = {
      id: 'test-provider-sdk',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'SDK_BASED_NOT_USED',
        method: 'POST',
        headers: {}
      }
    };

    const providerHttp: any = {
      id: 'test-provider-http',
      compat: 'test-compat',
      endpoint: {
        urlTemplate: 'http://service/{model}',
        method: 'POST',
        headers: {}
      }
    };

    async function* sdkStream() {
      yield { type: 'content_start' };
    }

    const sdkCompat = {
      streamSDK: jest.fn().mockReturnValue(sdkStream())
    };

    const sdkRegistry = {
      getCompatModule: jest.fn().mockReturnValue(sdkCompat)
    } as any;

    const sdkManager = new LLMManager(sdkRegistry);
    const sdkIterator = sdkManager.streamProvider(providerSdk, 'model-x', {}, messages as any, []);
    await sdkIterator.next();

    expect(sdkCompat.streamSDK).toHaveBeenCalled();
    expect(sdkCompat.streamSDK.mock.calls[0][2]).toEqual(expected);

    const httpCompat = {
      buildPayload: jest.fn(() => ({})),
      getStreamingFlags: jest.fn(() => ({})),
      parseResponse: jest.fn(() => ({ role: Role.ASSISTANT, content: [] })),
      serializeTools: jest.fn(),
      serializeToolChoice: jest.fn()
    };

    const httpRegistry = {
      getCompatModule: jest.fn().mockReturnValue(httpCompat)
    } as any;

    const httpManager = new LLMManager(httpRegistry);
    (httpManager as any).httpClient = {
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

    const httpIterator = httpManager.streamProvider(providerHttp, 'model-x', {}, messages as any, []);
    await httpIterator.next();

    expect(httpCompat.buildPayload).toHaveBeenCalled();
    expect(httpCompat.buildPayload.mock.calls[0][2]).toEqual(expected);
  });
});
