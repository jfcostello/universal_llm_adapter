import crypto from 'crypto';
import { jest } from '@jest/globals';

import VapiVoiceCompat from '../../index.ts';

type FakeFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
};

function installFetch(mock: (url: string, init: any) => Promise<FakeFetchResponse>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => mock(String(url), init)) as any;
  return { restore: () => { globalThis.fetch = original; } };
}

function hmac(options: { algorithm: 'sha256' | 'sha512' | 'sha1'; key: string | Buffer; payload: string; encoding: 'hex' | 'base64' }): string {
  return crypto.createHmac(options.algorithm, options.key).update(options.payload, 'utf8').digest(options.encoding);
}

describe('plugins/voice-compat/vapi', () => {
  test('validateWebhookRequest: bearer token auth', async () => {
    const compat = new VapiVoiceCompat();

    // type omitted to cover bearer default
    const providerDefaults = { webhookAuth: { token: 'tok_1' } };

    await expect(
      compat.validateWebhookRequest({
        req: { headers: {} } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { authorization: 'Bearer nope' } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { authorization: ['Bearer tok_1'] } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults
      })
    ).resolves.toBeUndefined();

    // empty arrays should be treated as missing
    await expect(
      compat.validateWebhookRequest({
        req: { headers: { authorization: [] } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { authorization: 'Basic abc' } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('validateWebhookRequest: bearer token config must include token', async () => {
    const compat = new VapiVoiceCompat();

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { authorization: 'Bearer tok' } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults: { webhookAuth: { type: 'bearer', token: '' } }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { authorization: 'Bearer tok' } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults: { webhookAuth: { type: 'bearer' } }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('validateWebhookRequest: hmac auth requires secretKey + algorithm', async () => {
    const compat = new VapiVoiceCompat();

    await expect(
      compat.validateWebhookRequest({
        req: { headers: {} } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults: { webhookAuth: { type: 'hmac', algorithm: 'sha256' } }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: {} } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults: { webhookAuth: { type: 'hmac', secretKey: 'secret_1' } }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('validateWebhookRequest: hmac auth (timestamp + body)', async () => {
    const compat = new VapiVoiceCompat();

    const providerDefaults = {
      webhookAuth: {
        type: 'hmac',
        secretKey: 'secret_1',
        algorithm: 'sha256',
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        signatureEncoding: 'hex',
        includeTimestamp: true,
        payloadFormat: '{timestamp}.{body}'
      }
    };

    const bodyText = JSON.stringify({ message: { type: 'status-update', status: 'queued' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = `${timestamp}.${bodyText}`;
    const signature = hmac({ algorithm: 'sha256', key: 'secret_1', payload, encoding: 'hex' });

    await expect(
      compat.validateWebhookRequest({
        req: {
          headers: {
            'x-signature': signature,
            'x-timestamp': timestamp
          }
        } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        bodyText,
        providerDefaults
      })
    ).resolves.toBeUndefined();
  });

  test('validateWebhookRequest: hmac supports signaturePrefix + base64 signatureEncoding + base64 secrets', async () => {
    const compat = new VapiVoiceCompat();

    const secretBytes = Buffer.from('secret_2', 'utf8');
    const secretKey = secretBytes.toString('base64');
    const providerDefaults = {
      webhookAuth: {
        type: 'hmac',
        secretKey,
        secretIsBase64: true,
        algorithm: 'sha512',
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        signatureEncoding: 'base64',
        signaturePrefix: 'sha512=',
        includeTimestamp: true,
        // cover non-numeric timestamp tolerance bypass
        payloadFormat: '{timestamp}.{body}.{method}.{url}.{svix-id}',
        toleranceSeconds: 'nope'
      }
    };

    const bodyText = JSON.stringify({ message: { type: 'status-update', status: 'queued' } });
    const timestamp = 'abc';
    const url = 'https://example.test/voice/webhook?callConfigId=cfg_1';
    const payload = `${timestamp}.${bodyText}.POST.${url}.m1`;
    const signature = hmac({ algorithm: 'sha512', key: secretBytes, payload, encoding: 'base64' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': `sha512=${signature}`, 'x-timestamp': timestamp, 'svix-id': 'm1' } } as any,
        method: 'POST',
        url,
        bodyText,
        providerDefaults
      })
    ).resolves.toBeUndefined();
  });

  test('validateWebhookRequest: hmac can default headers and fill missing body/method/url', async () => {
    const compat = new VapiVoiceCompat();

    const providerDefaults = {
      webhookAuth: {
        type: 'hmac',
        secretKey: 'secret_5',
        algorithm: 'sha256',
        // ensure fallback to defaults when trimmed to empty
        signatureHeader: '  ',
        timestampHeader: '  ',
        signatureEncoding: 'hex',
        includeTimestamp: true,
        // cover body/method/url defaults + svix-id default
        payloadFormat: '{timestamp}.{body}.{method}.{url}.{svix-id}',
        toleranceSeconds: 0
      }
    };

    const timestamp = 'abc';
    const bodyText = '';
    const url = '';

    // omit options.method so it falls back to req.method
    const methodFromReq = 'PUT';
    const payload1 = `${timestamp}.${bodyText}.${methodFromReq}.${url}.`;
    const signature1 = hmac({ algorithm: 'sha256', key: 'secret_5', payload: payload1, encoding: 'hex' });

    await expect(
      compat.validateWebhookRequest({
        req: { method: methodFromReq, headers: { 'x-signature': signature1, 'x-timestamp': timestamp } } as any,
        providerDefaults
      } as any)
    ).resolves.toBeUndefined();

    // omit req.method too so method defaults to POST
    const payload2 = `${timestamp}.${bodyText}.POST.${url}.`;
    const signature2 = hmac({ algorithm: 'sha256', key: 'secret_5', payload: payload2, encoding: 'hex' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': signature2, 'x-timestamp': timestamp } } as any,
        providerDefaults
      } as any)
    ).resolves.toBeUndefined();
  });

  test('validateWebhookRequest: hmac rejects missing signature/timestamp and invalid signatures + timestamps', async () => {
    const compat = new VapiVoiceCompat();
    const url = 'https://example.test/voice/webhook?callConfigId=cfg_1';
    const bodyText = '{}';

    const providerDefaults = {
      webhookAuth: {
        type: 'hmac',
        secretKey: 'secret_3',
        algorithm: 'sha1',
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        signatureEncoding: 'hex',
        includeTimestamp: true,
        payloadFormat: '{timestamp}.{body}',
        toleranceSeconds: 1
      }
    };

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-timestamp': '1' } } as any,
        method: 'POST',
        url,
        bodyText,
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': 'x' } } as any,
        method: 'POST',
        url,
        bodyText,
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    // too old timestamp triggers tolerance error
    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': 'x', 'x-timestamp': '1' } } as any,
        method: 'POST',
        url,
        bodyText,
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    // invalid signature
    const timestamp = String(Date.now());
    const payload = `${timestamp}.${bodyText}`;
    const signature = hmac({ algorithm: 'sha1', key: 'secret_3', payload, encoding: 'hex' });
    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': `${signature}0`, 'x-timestamp': timestamp } } as any,
        method: 'POST',
        url,
        bodyText,
        providerDefaults
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('validateWebhookRequest: hmac can ignore timestamps when includeTimestamp=false', async () => {
    const compat = new VapiVoiceCompat();

    const providerDefaults = {
      webhookAuth: {
        type: 'hmac',
        secretKey: 'secret_4',
        algorithm: 'sha256',
        signatureHeader: 'x-signature',
        includeTimestamp: false,
        payloadFormat: '{body}',
        signatureEncoding: 'hex'
      }
    };

    const bodyText = JSON.stringify({ ok: true });
    const signature = hmac({ algorithm: 'sha256', key: 'secret_4', payload: bodyText, encoding: 'hex' });

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': signature } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        bodyText,
        providerDefaults
      })
    ).resolves.toBeUndefined();
  });

  test('createOutboundCall: validates inputs, provider defaults, and webhook url', async () => {
    const compat = new VapiVoiceCompat();

    await expect(
      compat.createOutboundCall({ to: '', from: 'x', callConfigId: 'cfg_1' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

    await expect(
      compat.createOutboundCall({ to: undefined, from: 'x', callConfigId: 'cfg_1' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

    await expect(
      compat.createOutboundCall({ to: 'to', from: undefined, callConfigId: 'cfg_1' } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

    await expect(
      compat.createOutboundCall({ to: 'to', from: 'from', callConfigId: undefined } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        mediaWsUrl: '',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: '', webhookAuth: { type: 'bearer', token: 't' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'nope', model: 'model_x' } },
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        mediaWsUrl: 'not a url',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'hmac', secretKey: 's', algorithm: 'sha256' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: undefined, webhookAuth: { type: 'bearer', token: 't' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { model: 'model_x' } },
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('createOutboundCall: assistantFirstTurn validation (prompt + delayMs)', async () => {
    const compat = new VapiVoiceCompat();

    const fetchMock = installFetch(async () => ({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => ({ id: 'call_1' })
    }));

    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: {
            assistantFirstTurn: { enabled: true, missingPromptBehavior: 'reject' },
            realtimeSpec: { provider: 'vapi', model: 'model_x' }
          },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: {
            assistantFirstTurn: { enabled: true, prompt: 'hi', delayMs: 'nope' },
            realtimeSpec: { provider: 'vapi', model: 'model_x' }
          },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: {
            assistantFirstTurn: { enabled: true, prompt: 'hi', delayMs: 10 },
            realtimeSpec: { provider: 'vapi', model: 'model_x' }
          },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });

      const ok = await compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: {
          assistantFirstTurn: { enabled: true, missingPromptBehavior: 'skip' },
          realtimeSpec: { provider: 'vapi' }
        },
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
      } as any);
      expect(ok.providerCallId).toBe('call_1');
    } finally {
      fetchMock.restore();
    }
  });

  test('createOutboundCall: surfaces fetch failures and provider errors', async () => {
    const compat = new VapiVoiceCompat();

    const fetchThrow = installFetch(async () => {
      throw new Error('network');
    });
    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: { provider: 'vapi' } },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchThrow.restore();
    }

    const fetchThrowNoMessage = installFetch(async () => {
      throw { nope: true };
    });
    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: { provider: 'vapi' } },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchThrowNoMessage.restore();
    }

    const fetchBad = installFetch(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'bad'
    }));
    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: { provider: 'vapi' } },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchBad.restore();
    }

    const fetchBadTextThrows = installFetch(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => { throw new Error('boom'); }
    }));
    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: { provider: 'vapi' } },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchBadTextThrows.restore();
    }

    const fetchNoId = installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.assistant.model.model).toBe('gpt-4o-mini');
      expect(body.assistant.model.temperature).toBeUndefined();
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({}) };
    });
    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: { provider: 'vapi', settings: { temperature: 'nope' } } },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchNoId.restore();
    }

    const fetchJsonThrows = installFetch(async () => ({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => { throw new Error('boom'); }
    }));
    try {
      await expect(
        compat.createOutboundCall({
          to: 'to',
          from: 'from',
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: { provider: 'vapi' } },
          mediaWsUrl: 'ws://example.test/voice/media?token=abc',
          providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchJsonThrows.restore();
    }
  });

  test('createOutboundCall: shapes Vapi call create request and uses /voice/webhook server url', async () => {
    const fetchMock = installFetch(async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      expect(method).toBe('POST');
      expect(url).toBe('https://vapi.test/call');
      expect(init.headers.Authorization).toBe('Bearer api_key');

      const body = JSON.parse(init.body);
      expect(body.phoneNumberId).toBe('pn_1');
      expect(body.customer.number).toBe('+15550001111');

      expect(body.assistant.model.provider).toBe('google');
      expect(body.assistant.model.model).toBe('model_x');
      expect(body.assistant.firstMessageMode).toBe('assistant-speaks-first-with-model-generated-message');
      expect(Array.isArray(body.assistant.model.messages)).toBe(true);
      expect(body.assistant.model.messages[0]?.role).toBe('system');
      expect(body.assistant.model.messages[1]?.role).toBe('user');
      expect(String(body.assistant.model.messages[1]?.content)).toContain('Say hi');
      expect(body.assistant.voice.provider).toBe('openai');
      expect(body.assistant.voice.voiceId).toBe('alloy');
      expect(body.assistant.voice.speed).toBe(1.1);

      expect(body.assistant.server.url).toBe('http://example.test/voice/webhook?callConfigId=cfg_1');
      expect(body.assistant.server.headers.Authorization).toBe('Bearer webhook_tok');
      expect(Array.isArray(body.assistant.serverMessages)).toBe(true);
      expect(body.assistant.serverMessages).toContain('status-update');
      expect(body.assistant.serverMessages).toContain('transcript');

      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({ id: 'call_1' })
      };
    });

    try {
      const compat = new VapiVoiceCompat();
      const res = await compat.createOutboundCall({
        to: '+15550001111',
        from: 'pn_1',
        callConfigId: 'cfg_1',
        callConfig: {
          systemPrompt: 'You are helpful.',
          assistantFirstTurn: { enabled: true, prompt: 'Say hi.', role: 'user', delayMs: 0, missingPromptBehavior: 'reject' },
          realtimeSpec: { provider: 'vapi', model: 'model_x', settings: { modelProvider: 'google', voice: 'alloy', speed: 1.1 } }
        },
        voiceProvider: 'vapi',
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: {
          apiKey: 'api_key',
          apiBaseUrl: 'https://vapi.test',
          webhookAuth: { type: 'bearer', token: 'webhook_tok' }
        }
      } as any);

      expect(res.providerCallId).toBe('call_1');
    } finally {
      fetchMock.restore();
    }
  });

  test('createOutboundCall: defaults transcriber when transcription values are blank', async () => {
    const fetchMock = installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.assistant.transcriber.provider).toBe('deepgram');
      expect(body.assistant.transcriber.model).toBe('nova-2');
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({ id: 'call_blank_transcriber' }) };
    });

    try {
      const compat = new VapiVoiceCompat();
      const res = await compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'vapi', transcription: { provider: '  ', model: '  ' } }
        },
        voiceProvider: 'vapi',
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'k', webhookAuth: { type: 'bearer', token: 't' } }
      } as any);

      expect(res.providerCallId).toBe('call_blank_transcriber');
    } finally {
      fetchMock.restore();
    }
  });

  test('createOutboundCall: defaults apiBaseUrl when empty', async () => {
    const fetchMock = installFetch(async (url) => {
      expect(url).toBe('https://api.vapi.ai/call');
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({ id: 'call_default_base' }) };
    });

    try {
      const compat = new VapiVoiceCompat();
      const res = await compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'vapi' } },
        voiceProvider: 'vapi',
        mediaWsUrl: 'ws://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'k', apiBaseUrl: '', webhookAuth: { type: 'bearer', token: 't' } }
      } as any);

      expect(res.providerCallId).toBe('call_default_base');
    } finally {
      fetchMock.restore();
    }
  });

  test('createOutboundCall: supports wss media urls + temperature and transcriber overrides', async () => {
    const fetchMock = installFetch(async (url, init) => {
      expect(url).toBe('https://vapi.test/call');

      const body = JSON.parse(init.body);
      expect(body.assistant.server.url).toBe('https://example.test/voice/webhook?callConfigId=cfg_1');
      expect(body.assistant.model.temperature).toBe(0.9);
      expect(body.assistant.transcriber.provider).toBe('transcriber_x');
      expect(body.assistant.transcriber.model).toBe('transcriber_model_x');
      expect(body.assistant.model.messages[0]?.role).toBe('system');

      return { ok: true, status: 201, statusText: 'Created', json: async () => ({ id: 'call_2' }) };
    });

    try {
      const compat = new VapiVoiceCompat();
      const res = await compat.createOutboundCall({
        to: '+15550001111',
        from: 'pn_1',
        callConfigId: 'cfg_1',
        callConfig: {
          assistantFirstTurn: { enabled: true, prompt: 'Hi', role: 'system' },
          realtimeSpec: {
            provider: 'vapi',
            model: 'model_x',
            transcription: { provider: 'transcriber_x', model: 'transcriber_model_x' },
            settings: { temperature: 0.9 }
          }
        },
        voiceProvider: 'vapi',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {
          apiKey: 'api_key',
          apiBaseUrl: 'https://vapi.test',
          webhookAuth: { type: 'bearer', token: 'webhook_tok' }
        }
      } as any);

      expect(res.providerCallId).toBe('call_2');
    } finally {
      fetchMock.restore();
    }
  });

  test('createWebhookResponse: maps transcript + speech/status updates to normalized events', async () => {
    const compat = new VapiVoiceCompat();

    const emitted: any[] = [];
    const emitThrowsOnce = jest.fn((evt: any) => {
      emitted.push(evt);
      throw new Error('boom');
    });

    const res1 = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'hello', call: { id: 'call_1' } } },
      events: { emit: emitThrowsOnce }
    } as any);
    expect(res1.status).toBe(200);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript', role: 'assistant', transcriptType: 'partial', transcript: 'hi', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: {},
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript[transcriptType=\"final\"]', role: 'user', transcript: 'finalish' } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'he', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'speech-update', role: 'user', status: 'started', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'speech-update', role: 'user', status: 'stopped', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'speech-update', role: 'assistant', status: 'started', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'speech-update', role: 'assistant', status: 'stopped', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'status-update', status: 'in-progress', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'status-update', status: 'ended', endedReason: 'x', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'status-update', status: 'ended', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'end-of-call-report', endedReason: 'y', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'bye', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    // unknown/invalid transcript role/type should no-op
    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript', role: 'nope', transcriptType: 'final', transcript: 'skip', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    // missing or invalid fields should no-op
    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: {},
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'transcript' } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'speech-update' } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'status-update' } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1' },
      voiceProvider: 'vapi',
      body: { message: { type: 'end-of-call-report', call: { id: 'call_1' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    expect(emitted.some(e => e?.type === 'user_transcript.final' && String(e?.text).includes('hello'))).toBe(true);
    expect(emitted.some(e => e?.type === 'assistant_transcript.delta')).toBe(true);
    expect(emitted.some(e => e?.type === 'assistant_transcript.final' && String(e?.text).includes('bye'))).toBe(true);
    expect(emitted.some(e => e?.type === 'user_transcript.final' && String(e?.text).includes('finalish'))).toBe(true);
    expect(emitted.some(e => e?.type === 'user_transcript.delta')).toBe(true);
    expect(emitted.some(e => e?.type === 'user_speech.started')).toBe(true);
    expect(emitted.some(e => e?.type === 'user_speech.stopped')).toBe(true);
    expect(emitted.some(e => e?.type === 'voice.assistant_audio.started')).toBe(true);
    expect(emitted.some(e => e?.type === 'voice.assistant_audio.ended')).toBe(true);
    expect(emitted.some(e => e?.type === 'voice.playback.drained')).toBe(true);
    expect(emitted.some(e => e?.type === 'voice.call.connected')).toBe(true);
    expect(emitted.some(e => e?.type === 'voice.call.ended' && e?.endedReason === 'x')).toBe(true);
  });

  test('endCall: posts end-call to monitor.controlUrl', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = installFetch(async (url, init) => {
      calls.push({ url, init });
      const method = String(init?.method ?? 'GET').toUpperCase();

      if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } })
        };
      }

      if (method === 'POST' && url === 'https://vapi.test/control') {
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(init.body)).toEqual({ type: 'end-call' });
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }) };
      }

      return { ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' };
    });

    try {
      const compat = new VapiVoiceCompat();
      await compat.endCall({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1' },
        providerCallId: 'call_1',
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test' }
      } as any);

      expect(calls.some(c => c.url === 'https://vapi.test/control')).toBe(true);
    } finally {
      fetchMock.restore();
    }
  });

  test('endCall: noops when providerCallId missing', async () => {
    const compat = new VapiVoiceCompat();
    const fetchSpy = jest.fn(async () => ({ ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' }));
    const fetchMock = installFetch(fetchSpy);
    try {
      await compat.endCall({ callConfigId: 'cfg_1', providerCallId: '', voiceProvider: 'vapi' } as any);
      await compat.endCall({ callConfigId: 'cfg_1', providerCallId: undefined, voiceProvider: 'vapi' } as any);
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally {
      fetchMock.restore();
    }
  });

  test('endCall: uses callConfig.providerCallId when providerCallId is missing', async () => {
    const compat = new VapiVoiceCompat();

    const fetchSpy = jest.fn(async (url: string, init: any) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } }) };
      }
      if (method === 'POST' && url === 'https://vapi.test/control') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' };
    });

    const fetchMock = installFetch(fetchSpy);
    try {
      await compat.endCall({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1' },
        providerCallId: undefined,
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test' }
      } as any);

      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchMock.restore();
    }
  });

  test('endCall: defaults apiBaseUrl and handles provider GET/control errors with empty bodies', async () => {
    const compat = new VapiVoiceCompat();

    // cover apiKey missing (undefined), poll/maxWait non-numeric defaults, GET text() throwing, and POST text() throwing
    await expect(
      compat.endCall({ callConfigId: 'cfg_1', providerCallId: 'call_1', voiceProvider: 'vapi', providerDefaults: {} } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    const fetchMock = installFetch(async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();

      if (method === 'GET' && url === 'https://api.vapi.ai/call/call_poll') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'call_poll', monitor: { controlUrl: 'https://api.vapi.ai/control' } }) };
      }

      if (method === 'GET' && url === 'https://api.vapi.ai/call/call_get_err') {
        return { ok: false, status: 500, statusText: 'Boom', text: async () => { throw new Error('boom'); } };
      }

      if (method === 'GET' && url === 'https://api.vapi.ai/call/call_get_json_throw') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('boom'); } };
      }

      if (method === 'POST' && url === 'https://api.vapi.ai/control') {
        return { ok: false, status: 500, statusText: 'Boom', text: async () => { throw new Error('boom'); } };
      }

      return { ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' };
    });

    try {
      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_poll',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: '', controlUrlMaxWaitMs: 'nope', controlUrlPollMs: 'nope' }
        } as any)
      ).rejects.toBeInstanceOf(Error);

      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_get_err',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: '', controlUrlMaxWaitMs: 100, controlUrlPollMs: 100 }
        } as any)
      ).rejects.toBeInstanceOf(Error);

      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_get_json_throw',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: '', controlUrlMaxWaitMs: 100, controlUrlPollMs: 100 }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchMock.restore();
    }
  });

  test('endCall: validates provider defaults and surfaces provider errors', async () => {
    const compat = new VapiVoiceCompat();

    await expect(
      compat.endCall({ callConfigId: 'cfg_1', providerCallId: 'call_1', voiceProvider: 'vapi', providerDefaults: { apiKey: '' } } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    const fetchMock = installFetch(async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'call_1' }) };
      }
      return { ok: false, status: 400, statusText: 'Bad', text: async () => 'bad' };
    });

    try {
      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_1',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test', controlUrlMaxWaitMs: 100, controlUrlPollMs: 100 }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchMock.restore();
    }
  });

  test('endCall: throws when controlUrl cannot be resolved, and when controlUrl rejects', async () => {
    const compat = new VapiVoiceCompat();

    const fetchNoControl = installFetch(async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'call_1', monitor: {} }) };
      }
      return { ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' };
    });
    try {
      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_1',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test', controlUrlMaxWaitMs: 100, controlUrlPollMs: 100 }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchNoControl.restore();
    }

    const fetchControlRejects = installFetch(async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } }) };
      }
      if (method === 'POST' && url === 'https://vapi.test/control') {
        return { ok: false, status: 500, statusText: 'Boom', text: async () => 'nope' };
      }
      return { ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' };
    });
    try {
      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_1',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchControlRejects.restore();
    }
  });

  test('endCall: includes provider GET failures in controlUrl unavailable error', async () => {
    const compat = new VapiVoiceCompat();

    const fetchMock = installFetch(async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
        return { ok: false, status: 500, statusText: 'Boom', text: async () => 'nope' };
      }
      return { ok: false, status: 500, statusText: 'unexpected', text: async () => 'unexpected' };
    });

    try {
      await expect(
        compat.endCall({
          callConfigId: 'cfg_1',
          providerCallId: 'call_1',
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test', controlUrlMaxWaitMs: 100, controlUrlPollMs: 100 }
        } as any)
      ).rejects.toBeInstanceOf(Error);
    } finally {
      fetchMock.restore();
    }
  });

  test('handleMediaConnection: closes ws (swallows errors)', async () => {
    const compat = new VapiVoiceCompat();

    const ws1 = { close: jest.fn() };
    await compat.handleMediaConnection({ ws: ws1 } as any);
    expect(ws1.close).toHaveBeenCalledTimes(1);

    const ws2 = { close: jest.fn(() => { throw new Error('boom'); }) };
    await compat.handleMediaConnection({ ws: ws2 } as any);
    expect(ws2.close).toHaveBeenCalledTimes(1);
  });
});
