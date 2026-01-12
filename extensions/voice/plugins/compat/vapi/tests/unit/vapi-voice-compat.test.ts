import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

describe('plugins/compat/vapi', () => {
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
        // cover signature prefix + base64 secret/signature + non-numeric toleranceSeconds normalization
        payloadFormat: '{timestamp}.{body}.{method}.{url}.{svix-id}',
        toleranceSeconds: 'nope'
      }
    };

    const bodyText = JSON.stringify({ message: { type: 'status-update', status: 'queued' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
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

  test('validateWebhookRequest: hmac rejects non-numeric timestamps when tolerance is enabled', async () => {
    const compat = new VapiVoiceCompat();

    const providerDefaults = {
      webhookAuth: {
        type: 'hmac',
        secretKey: 'secret_6',
        algorithm: 'sha256',
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        signatureEncoding: 'hex',
        includeTimestamp: true,
        payloadFormat: '{timestamp}.{body}',
        toleranceSeconds: 300
      }
    };

    await expect(
      compat.validateWebhookRequest({
        req: { headers: { 'x-signature': 'sig', 'x-timestamp': 'abc' } } as any,
        method: 'POST',
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        providerDefaults
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
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
      expect(body.assistant.artifactPlan).toBeUndefined();
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
      expect(body.assistant.serverMessages).toContain('tool-calls');

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
      expect(body.assistant.artifactPlan.recordingEnabled).toBe(true);
      expect(body.assistant.artifactPlan.recordingFormat).toBe('mp3');
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
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' },
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

  test('createOutboundCall: maps recording.format=wav to artifactPlan.recordingFormat=wav;l16', async () => {
    const fetchMock = installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.assistant.artifactPlan.recordingEnabled).toBe(true);
      expect(body.assistant.artifactPlan.recordingFormat).toBe('wav;l16');
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({ id: 'call_wav' }) };
    });

    try {
      const compat = new VapiVoiceCompat();
      const res = await compat.createOutboundCall({
        to: 'to',
        from: 'from',
        callConfigId: 'cfg_1',
        callConfig: {
          recording: { enabled: true, format: 'wav', channels: 'mono' },
          realtimeSpec: { provider: 'vapi' }
        },
        voiceProvider: 'vapi',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: { apiKey: 'api_key', webhookAuth: { type: 'bearer', token: 'webhook_tok' } }
      } as any);

      expect(res.providerCallId).toBe('call_wav');
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

    // ensure end-of-call-report can emit ended events when it is the first terminal webhook
    await compat.createWebhookResponse({
      callConfigId: 'cfg_2',
      callConfig: { providerCallId: 'call_2' },
      voiceProvider: 'vapi',
      body: { message: { type: 'end-of-call-report', endedReason: 'z', call: { id: 'call_2' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_3',
      callConfig: { providerCallId: 'call_3' },
      voiceProvider: 'vapi',
      body: { message: { type: 'status-update', status: 'ended', call: { id: 'call_3' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    await compat.createWebhookResponse({
      callConfigId: 'cfg_4',
      callConfig: { providerCallId: 'call_4' },
      voiceProvider: 'vapi',
      body: { message: { type: 'end-of-call-report', call: { id: 'call_4' } } },
      events: { emit: (evt: any) => emitted.push(evt) }
    } as any);

    // cover ended-event dedupe fallback for empty keys (should not throw)
    await compat.createWebhookResponse({
      callConfigId: '',
      callConfig: {},
      voiceProvider: 'vapi',
      body: { message: { type: 'end-of-call-report', endedReason: 'empty-key' } },
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
    const endedCall1 = emitted.filter(e => e?.type === 'voice.call.ended' && e?.providerCallId === 'call_1');
    expect(endedCall1).toHaveLength(1);
    expect(endedCall1[0]?.endedReason).toBe('x');

    const endedCall2 = emitted.filter(e => e?.type === 'voice.call.ended' && e?.providerCallId === 'call_2');
    expect(endedCall2).toHaveLength(1);
    expect(endedCall2[0]?.endedReason).toBe('z');

    const endedCall3 = emitted.filter(e => e?.type === 'voice.call.ended' && e?.providerCallId === 'call_3');
    expect(endedCall3).toHaveLength(1);
    expect(endedCall3[0]?.endedReason).toBeUndefined();

    const endedCall4 = emitted.filter(e => e?.type === 'voice.call.ended' && e?.providerCallId === 'call_4');
    expect(endedCall4).toHaveLength(1);
    expect(endedCall4[0]?.endedReason).toBeUndefined();

    expect(emitted.some(e => e?.type === 'voice.call.ended' && e?.endedReason === 'empty-key')).toBe(true);
  });

  test('createWebhookResponse: executes tool-calls via process routes and returns results', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [
            {
              id: 'tc_1',
              type: 'function',
              function: { name: 'test.echo', arguments: JSON.stringify({ message: 'hello' }) }
            }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_1', result: '[R:5]olleh' }]);
  });

  test('createWebhookResponse: supports function-call shaped webhook and returns tool result', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'function-call',
          toolCallId: 'tc_2',
          functionCall: { id: 'tc_2', name: 'test.echo', parameters: { message: 'world' } },
          call: { id: 'call_1' }
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_2', result: '[R:5]dlrow' }]);
  });

  test('createWebhookResponse: returns tool error in results when tool execution fails', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [
            {
              id: 'tc_fail',
              type: 'function',
              function: { name: 'test.echo', arguments: JSON.stringify({ nope: true }) }
            }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_fail', error: expect.any(String) }]);
    expect(String(body.results[0]?.error ?? '')).not.toContain('\n');
  });

  test('createWebhookResponse: uses tool_invocation_failed when tool errors end with undefined/null', async () => {
    const compat = new VapiVoiceCompat();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-vapi-tool-'));
    try {
      const modulePath = path.join(tmpDir, 'thrower.mjs');
      fs.writeFileSync(
        modulePath,
        [
          `export function handle(ctx) {`,
          `  if (ctx.callId === 'tc_null') {`,
          `    throw { message: null };`,
          `  }`,
          `  throw {};`,
          `}`,
          ``
        ].join('\n'),
        'utf8'
      );

      const registry = {
        getProcessRoutes: async () => [
          {
            id: 'thrower',
            match: { type: 'exact', pattern: 'test.throw' },
            invoke: { kind: 'module', module: modulePath, function: 'handle' },
            timeoutMs: 1000
          }
        ]
      };

      const res = await compat.createWebhookResponse({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        voiceProvider: 'vapi',
        registry,
        body: {
          message: {
            type: 'tool-calls',
            call: { id: 'call_1' },
            toolWithToolCallList: [],
            toolCallList: [
              {
                id: 'tc_undefined',
                type: 'function',
                function: { name: 'test.throw', arguments: JSON.stringify({}) }
              },
              {
                id: 'tc_null',
                type: 'function',
                function: { name: 'test.throw', arguments: JSON.stringify({}) }
              }
            ]
          }
        }
      } as any);

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toEqual([
        { name: 'test.throw', toolCallId: 'tc_undefined', error: 'tool_invocation_failed' },
        { name: 'test.throw', toolCallId: 'tc_null', error: 'tool_invocation_failed' }
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('createWebhookResponse: uses String(err) fallback when tool invocation rejects with a non-Error value', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const { ToolCoordinator } = await import('../../../../../../../modules/tools/index.js');
    const original = ToolCoordinator.prototype.routeAndInvoke;

    ToolCoordinator.prototype.routeAndInvoke = async () => {
      throw undefined;
    };

    try {
      const res = await compat.createWebhookResponse({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
        voiceProvider: 'vapi',
        registry,
        body: {
          message: {
            type: 'tool-calls',
            call: { id: 'call_1' },
            toolWithToolCallList: [],
            toolCallList: [
              {
                id: 'tc_non_error',
                type: 'function',
                function: { name: 'test.echo', arguments: JSON.stringify({ message: 'hi' }) }
              }
            ]
          }
        }
      } as any);

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_non_error', error: 'tool_invocation_failed' }]);
    } finally {
      ToolCoordinator.prototype.routeAndInvoke = original;
    }
  });

  test('createWebhookResponse: parses toolWithToolCallList when toolCallList is empty', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolCallList: [],
          toolWithToolCallList: [{ name: 'test.echo', toolCall: { id: 'tc_tw', parameters: { message: 'hey' } } }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_tw', result: '[R:3]yeh' }]);
  });

  test('createWebhookResponse: returns empty results when a tool-calls webhook has no tool calls', async () => {
    const compat = new VapiVoiceCompat();

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      body: { message: { type: 'tool-calls', call: { id: 'call_1' } } }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([]);
  });

  test('createWebhookResponse: returns tool_execution_unavailable when registry is missing', async () => {
    const compat = new VapiVoiceCompat();

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [{ id: 'tc_no_reg', name: 'test.echo', arguments: { message: 'hello' } }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_no_reg', error: 'tool_execution_unavailable' }]);
  });

  test('createWebhookResponse: returns invalid_tool_arguments when args JSON cannot be parsed', async () => {
    const compat = new VapiVoiceCompat();

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      body: {
        message: {
          type: 'tool-calls',
          toolCallId: 'tc_bad',
          name: 'test.echo',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [{ id: 'tc_ignored', name: 'test.echo', arguments: '{not json' }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_ignored', error: 'invalid_tool_arguments' }]);
  });

  test('createWebhookResponse: returns invalid_tool_arguments when args is an empty string', async () => {
    const compat = new VapiVoiceCompat();

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [{ id: 'tc_empty', name: 'test.echo', arguments: '' }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_empty', error: 'invalid_tool_arguments' }]);
  });

  test('createWebhookResponse: function-call falls back to message.toolCallId and parses functionCall.arguments', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: {} },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'function-call',
          toolCallId: 'tc_fallback',
          functionCall: { name: 'test.echo', arguments: JSON.stringify({ message: 'hi' }) }
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_fallback', result: '[R:2]ih' }]);
  });

  test('createWebhookResponse: omits call metadata when callConfigId and call ids are empty', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: '',
      callConfig: { realtimeSpec: {} },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          toolWithToolCallList: [],
          toolCallList: [
            {
              id: 'tc_meta_empty',
              type: 'function',
              function: { name: 'test.echo', arguments: JSON.stringify({ message: 'ok' }) }
            }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_meta_empty', result: '[R:2]ko' }]);
  });

  test('createWebhookResponse: extraction throw prefers message.functionCall.name and uses message.toolCallId', async () => {
    const compat = new VapiVoiceCompat();

    const throwing: any = {};
    Object.defineProperty(throwing, 'id', {
      get: () => {
        throw 'boom';
      }
    });

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      body: {
        message: {
          type: 'tool-calls',
          functionCall: { name: 'fallback_name' },
          toolCallId: 'tc_outer',
          toolWithToolCallList: [],
          toolCallList: [throwing]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].name).toBe('fallback_name');
    expect(body.results[0].toolCallId).toBe('tc_outer');
    expect(body.results[0].error).toBe('boom');
  });

  test('createWebhookResponse: returns invalid_tool_arguments for invalid toolWithToolCallList arguments (even with registry)', async () => {
    const compat = new VapiVoiceCompat();

    const registry = { getProcessRoutes: async () => [] };
    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolCallList: [],
          toolWithToolCallList: [
            {
              toolCallId: 'tc_tw_bad_args',
              toolCall: { function: { name: 'test.echo', arguments: '{not json' } }
            }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_tw_bad_args', error: 'invalid_tool_arguments' }]);
  });

  test('createWebhookResponse: returns invalid_tool_arguments for invalid function-call arguments (even with registry)', async () => {
    const compat = new VapiVoiceCompat();

    const registry = { getProcessRoutes: async () => [] };
    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'function-call',
          toolCallId: 'tc_fn_bad_args',
          functionCall: { name: 'test.echo', arguments: '{not json' }
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_fn_bad_args', error: 'invalid_tool_arguments' }]);
  });

  test('createWebhookResponse: merges toolCallList + toolWithToolCallList and dedupes by toolCallId', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolCallList: [
            {
              id: 'tc_1',
              type: 'function',
              function: { name: 'test.echo', arguments: JSON.stringify({ message: 'abc' }) }
            },
            {
              id: 'tc_dupe',
              type: 'function',
              function: { name: 'test.echo', arguments: JSON.stringify({ message: 'first' }) }
            }
          ],
          toolWithToolCallList: [
            {
              toolCallId: 'tc_2',
              toolCall: { function: { name: 'test.echo', arguments: JSON.stringify({ message: 'xy' }) } }
            },
            {
              toolCallId: 'tc_dupe',
              toolCall: { function: { name: 'test.echo', arguments: JSON.stringify({ message: 'second' }) } }
            }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([
      { name: 'test.echo', toolCallId: 'tc_1', result: '[R:3]cba' },
      { name: 'test.echo', toolCallId: 'tc_dupe', result: '[R:5]tsrif' },
      { name: 'test.echo', toolCallId: 'tc_2', result: '[R:2]yx' }
    ]);
  });

  test('createWebhookResponse: executes multiple tool calls in parallel (ordered results)', async () => {
    jest.useFakeTimers();

    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-control',
          match: { type: 'exact', pattern: 'test.control' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-control/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    let settled = false;
    const promise = compat
      .createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolCallList: [
            {
              id: 'tc_1',
              type: 'function',
              function: { name: 'test.control', arguments: JSON.stringify({ sleepMs: 100, override: 'a' }) }
            },
            {
              id: 'tc_2',
              type: 'function',
              function: { name: 'test.control', arguments: JSON.stringify({ sleepMs: 100, override: 'b' }) }
            }
          ]
        }
      }
    } as any)
      .then((res) => {
        settled = true;
        return res;
      })
      .catch((err) => {
        settled = true;
        throw err;
      });

    try {
      await Promise.resolve();
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(99);
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(true);

      const res = await promise;
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toHaveLength(2);
      expect(body.results[0].toolCallId).toBe('tc_1');
      expect(String(body.results[0].result)).toContain('"sleptMs":100');
      expect(body.results[1].toolCallId).toBe('tc_2');
      expect(String(body.results[1].result)).toContain('"sleptMs":100');
    } finally {
      await jest.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
      await Promise.resolve();
      await promise.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  test('createWebhookResponse: supports alternate toolCallId/name fields and skips invalid entries', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [
            {},
            { toolCallId: 'tc_alt', function: { name: 'test.echo', arguments: JSON.stringify({ message: 'yo' }) } }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_alt', result: '[R:2]oy' }]);
  });

  test('createWebhookResponse: supports toolWithToolCallList alternate fields and skips invalid entries', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-echo',
          match: { type: 'exact', pattern: 'test.echo' },
          invoke: { kind: 'module', module: './dist/plugins/modules/test-echo/index.js', function: 'handle' },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolCallList: [],
          toolWithToolCallList: [
            {},
            {
              toolCallId: 'tc_tw_alt',
              toolCall: { function: { name: 'test.echo', arguments: JSON.stringify({ message: 'ok' }) } }
            }
          ]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_tw_alt', result: '[R:2]ko' }]);
  });

  test('createWebhookResponse: stringifies tool results when the invocation payload is an object', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => [
        {
          id: 'test-cmd',
          match: { type: 'exact', pattern: 'test.cmd' },
          invoke: { kind: 'command', command: process.execPath, args: ['-e', 'console.log(JSON.stringify({\"foo\":\"bar\"}))'] },
          timeoutMs: 1000
        }
      ]
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [{ id: 'tc_cmd', name: 'test.cmd', arguments: {} }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.cmd', toolCallId: 'tc_cmd', result: '{\"foo\":\"bar\"}' }]);
  });

  test('createWebhookResponse: handles non-array process routes safely', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => ({ not: 'an array' })
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [{ id: 'tc_no_routes', name: 'test.echo', arguments: { message: 'hello' } }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_no_routes', error: expect.any(String) }]);
  });

  test('createWebhookResponse: tolerates registry.getProcessRoutes throwing', async () => {
    const compat = new VapiVoiceCompat();

    const registry = {
      getProcessRoutes: async () => {
        throw new Error('boom');
      }
    };

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_1' },
          toolWithToolCallList: [],
          toolCallList: [{ id: 'tc_routes_throw', name: 'test.echo', arguments: { message: 'hello' } }]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([{ name: 'test.echo', toolCallId: 'tc_routes_throw', error: expect.any(String) }]);
  });

  test('createWebhookResponse: returns empty results for function-call with missing fields', async () => {
    const compat = new VapiVoiceCompat();

    const registry = { getProcessRoutes: async () => [] };
    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      registry,
      body: { message: { type: 'function-call', functionCall: {} } }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toEqual([]);
  });

  test('createWebhookResponse: parse error defaults to name=\"tool\" when no name fields exist', async () => {
    const compat = new VapiVoiceCompat();

    const throwing: any = {};
    Object.defineProperty(throwing, 'id', {
      get: () => {
        throw 'boom';
      }
    });

    const res = await compat.createWebhookResponse({
      callConfigId: 'cfg_1',
      callConfig: { providerCallId: 'call_1', realtimeSpec: { provider: 'vapi', model: 'model_x' } },
      voiceProvider: 'vapi',
      body: {
        message: {
          type: 'tool-calls',
          toolWithToolCallList: [],
          toolCallList: [throwing]
        }
      }
    } as any);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].name).toBe('tool');
    expect(String(body.results[0].toolCallId)).toMatch(/^tool_/);
    expect(body.results[0].error).toBe('boom');
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

  test('getRecordingDownloadRequest: validates defaults and returns recording urls (stereo/mono)', async () => {
    const compat = new VapiVoiceCompat();

    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: '' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: '', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'k' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });

    const fetchStereo = installFetch(async (url, init) => {
      expect(String(init?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(url).toBe('https://vapi.test/call/call_2');

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          id: 'call_2',
          artifact: {
            recording: {
              stereoUrl: 'https://cdn.example/rec_stereo.mp3',
              mono: { combinedUrl: 'https://cdn.example/rec_mono.mp3' }
            }
          }
        })
      };
    });

    try {
      const stereo = await compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_2', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'dual' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
      } as any);
      expect(stereo.url).toBe('https://cdn.example/rec_stereo.mp3');
      expect(stereo.headers).toEqual({});
    } finally {
      fetchStereo.restore();
    }

    const fetchMono = installFetch(async (url, init) => {
      expect(String(init?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(url).toBe('https://vapi.test/call/call_3');

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          id: 'call_3',
          artifact: {
            recording: {
              mono: { combinedUrl: 'https://cdn.example/rec_mono.wav' }
            }
          }
        })
      };
    });

    try {
      const mono = await compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_3', recording: { enabled: true, mode: 'provider', format: 'wav', channels: 'mono' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
      } as any);
      expect(mono.url).toBe('https://cdn.example/rec_mono.wav');
      expect(mono.headers).toEqual({});
    } finally {
      fetchMono.restore();
    }

    const fetchApiHost = installFetch(async (url, init) => {
      expect(String(init?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(url).toBe('https://vapi.test/call/call_4');

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ id: 'call_4', artifact: { recording: 'https://vapi.test/recordings/call_4.mp3' } })
      };
    });

    try {
      const res = await compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_4', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'api_key', apiBaseUrl: 'https://vapi.test' }
      } as any);
      expect(res.url).toBe('https://vapi.test/recordings/call_4.mp3');
      expect(res.headers.Authorization).toBe('Bearer api_key');
    } finally {
      fetchApiHost.restore();
    }
  });

  test('getRecordingDownloadRequest: throws recording_not_ready when recording url is missing', async () => {
    const compat = new VapiVoiceCompat();

    const fetchMock = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'call_1', artifact: {} })
    }));

    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });
    } finally {
      fetchMock.restore();
    }
  });

  test('getRecordingDownloadRequest: handles invalid defaults, provider failures, and invalid recording urls', async () => {
    const compat = new VapiVoiceCompat();

    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: undefined,
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });

    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
        voiceProvider: 'vapi',
        providerDefaults: {}
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'k', apiBaseUrl: 'not a url' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });

    const fetchDefaultBase = installFetch(async (url, init) => {
      expect(String(init?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(url).toBe('https://api.vapi.ai/call/call_1');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ id: 'call_1', artifact: { recording: 'https://cdn.example/rec.mp3' } })
      };
    });
    try {
      const res = await compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3' } },
        voiceProvider: 'vapi',
        providerDefaults: { apiKey: 'k', apiBaseUrl: '' }
      } as any);
      expect(res.url).toBe('https://cdn.example/rec.mp3');
      expect(res.headers).toEqual({});
    } finally {
      fetchDefaultBase.restore();
    }

    const fetchThrow = installFetch(async () => { throw new Error('boom'); });
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 502, provider: 'vapi' });
    } finally {
      fetchThrow.restore();
    }

    const fetchThrowNoMessage = installFetch(async () => { throw { nope: true }; });
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 502, provider: 'vapi' });
    } finally {
      fetchThrowNoMessage.restore();
    }

    const fetchNotOk = installFetch(async () => ({ ok: false, status: 500, statusText: 'Boom', text: async () => 'nope' }));
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 500, provider: 'vapi' });
    } finally {
      fetchNotOk.restore();
    }

    const fetchNotOkEmpty = installFetch(async () => ({ ok: false, status: 500, statusText: 'Boom', text: async () => '' }));
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 500, provider: 'vapi' });
    } finally {
      fetchNotOkEmpty.restore();
    }

    const fetchNotOkTextThrows = installFetch(async () => ({
      ok: false,
      status: 500,
      statusText: 'Boom',
      text: async () => { throw new Error('boom'); }
    }));
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 500, provider: 'vapi' });
    } finally {
      fetchNotOkTextThrows.restore();
    }

    const fetchJsonThrows = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => { throw new Error('boom'); }
    }));
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });
    } finally {
      fetchJsonThrows.restore();
    }

    const fetchBadRecordingUrl = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'call_1', artifact: { recording: 'not a url' } })
    }));
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 500, code: 'provider_error' });
    } finally {
      fetchBadRecordingUrl.restore();
    }

    const fetchBadRecordingProtocol = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'call_1', artifact: { recording: 'file:///tmp/rec.mp3' } })
    }));
    try {
      await expect(
        compat.getRecordingDownloadRequest({
          callConfigId: 'cfg_1',
          callConfig: { providerCallId: 'call_1', recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' } },
          voiceProvider: 'vapi',
          providerDefaults: { apiKey: 'k', apiBaseUrl: 'https://vapi.test' }
        } as any)
      ).rejects.toMatchObject({ statusCode: 500, code: 'provider_error' });
    } finally {
      fetchBadRecordingProtocol.restore();
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
