import { jest } from '@jest/globals';

import OpenAIRealtimeCompat from '@/plugins/realtime-compat/openai/index.ts';

type FakeFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
};

function installFetch(mock: (url: string, init: any) => Promise<FakeFetchResponse>) {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = mock;
  return () => {
    (globalThis as any).fetch = original;
  };
}

describe('plugins/realtime-compat/openai — client secret minting', () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    jest.restoreAllMocks();
  });

  test('throws when clientSecretEndpoint config is missing', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    await expect(
      compat.mintClientSecret({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: { endpoint: { urlTemplate: 'https://sdp?model={model}' } }
        },
        spec: { provider: 'openai', model: 'm' }
      })
    ).rejects.toThrow('clientSecret');
  });

  test('mintClientSecret calls provider endpoint with derived headers/body and maps response', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async (url, init) => {
      expect(url).toBe('https://client-secrets.test/realtime/client_secrets');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer sk');
      expect(init.headers['Content-Type']).toBe('application/json');

      const parsed = JSON.parse(init.body);
      expect(parsed.expires_after).toEqual({ anchor: 'created_at', seconds: 60 });
      expect(parsed.session.type).toBe('realtime');
      expect(parsed.session.model).toBe('m');
      expect(parsed.session.instructions).toBe('hello');

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: 'ek_123', expires_at: 999 })
      };
    });

    const result = await compat.mintClientSecret({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: {
          endpoint: { urlTemplate: 'https://sdp?model={model}' },
          clientSecretEndpoint: {
            urlTemplate: 'https://client-secrets.test/realtime/client_secrets',
            headers: { Authorization: 'Bearer sk' }
          }
        }
      },
      spec: { provider: 'openai', model: 'm', systemPrompt: 'hello' },
      expiresAfterSeconds: 60
    });

    expect(result).toEqual({ clientSecret: 'ek_123', expiresAt: 999 });
  });

  test('mintClientSecret throws on non-2xx responses (uses response body)', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'nope'
    }));

    await expect(
      compat.mintClientSecret({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: {
            endpoint: { urlTemplate: 'https://sdp?model={model}' },
            clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets', headers: { Authorization: 'Bearer sk' } }
          }
        },
        spec: { provider: 'openai', model: 'm' }
      })
    ).rejects.toThrow('nope');
  });

  test('mintClientSecret throws on non-2xx responses (uses statusText when body read fails)', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => {
        throw new Error('read-failed');
      }
    }));

    await expect(
      compat.mintClientSecret({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: {
            endpoint: { urlTemplate: 'https://sdp?model={model}' },
            clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets', headers: { Authorization: 'Bearer sk' } }
          }
        },
        spec: { provider: 'openai', model: 'm' }
      })
    ).rejects.toThrow('Forbidden');
  });

  test('mintClientSecret throws when response is missing value', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({})
    }));

    await expect(
      compat.mintClientSecret({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: {
            endpoint: { urlTemplate: 'https://sdp?model={model}' },
            clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets', headers: { Authorization: 'Bearer sk' } }
          }
        },
        spec: { provider: 'openai', model: 'm' }
      })
    ).rejects.toThrow('client secret');
  });

  test('mintClientSecret uses defaultModel and omits expiresAt when not provided', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async (_url, init) => {
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.headers['Content-Type']).toBe('application/json');
      const parsed = JSON.parse(init.body);
      expect(parsed.session.model).toBe('dm');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: 'ek_456' })
      };
    });

    const result = await compat.mintClientSecret({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: {
          endpoint: { urlTemplate: 'https://sdp?model={model}' },
          clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets' }
        },
        metadata: { defaultModel: 'dm' }
      },
      spec: { provider: 'openai', systemPrompt: 'hello' },
      expiresAfterSeconds: 60
    });

    expect(result).toEqual({ clientSecret: 'ek_456' });
  });

  test('mintClientSecret throws when model is missing and no defaultModel is configured', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ value: 'ek_789' })
    }));

    await expect(
      compat.mintClientSecret({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: {
            endpoint: { urlTemplate: 'https://sdp?model={model}' },
            clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets' }
          }
        },
        spec: { provider: 'openai' }
      })
    ).rejects.toThrow("requires 'model'");
  });

  test('mintClientSecret resolves {model} placeholders in clientSecretEndpoint urlTemplate', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async (url, _init) => {
      expect(url).toBe('https://client-secrets.test/realtime/client_secrets?m=m');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: 'ek_123' })
      };
    });

    await compat.mintClientSecret({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: {
          endpoint: { urlTemplate: 'https://sdp?model={model}' },
          clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets?m={model}', headers: { Authorization: 'Bearer sk' } }
        }
      },
      spec: { provider: 'openai', model: 'm' }
    });
  });

  test('mintClientSecret resolves {model} placeholders in clientSecretEndpoint query', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    restoreFetch = installFetch(async (url, _init) => {
      expect(url).toBe('https://client-secrets.test/realtime/client_secrets?m=m');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: 'ek_123' })
      };
    });

    await compat.mintClientSecret({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: {
          endpoint: { urlTemplate: 'https://sdp?model={model}' },
          clientSecretEndpoint: {
            urlTemplate: 'https://client-secrets.test/realtime/client_secrets',
            query: { m: '{model}' },
            headers: { Authorization: 'Bearer sk' }
          }
        }
      },
      spec: { provider: 'openai', model: 'm' }
    });
  });

  test('mintClientSecret rejects when urlTemplate requires {model} but no model is available', async () => {
    const compat = new OpenAIRealtimeCompat() as any;

    await expect(
      compat.mintClientSecret({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: {
            endpoint: { urlTemplate: 'https://sdp?model={model}' },
            clientSecretEndpoint: { urlTemplate: 'https://client-secrets.test/realtime/client_secrets?m={model}', headers: { Authorization: 'Bearer sk' } }
          }
        },
        spec: { provider: 'openai' }
      })
    ).rejects.toThrow("requires 'model'");
  });
});
