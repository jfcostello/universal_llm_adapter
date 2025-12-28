import crypto from 'crypto';
import type http from 'http';

import { ProviderExecutionError } from '../../../kernel/index.js';
import { createRealtimeSession } from '../../../modules/realtime/index.js';
import { createTwilioMediaStreamsBridge } from '../../voice-modules/twilio-media-streams/index.js';

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwiMLConnectStream(options: { wsUrl: string; parameters: Record<string, string> }): string {
  const wsUrl = escapeXmlAttr(String(options.wsUrl));

  const params = Object.entries(options.parameters)
    .filter(([_, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `      <Parameter name=\"${escapeXmlAttr(String(k))}\" value=\"${escapeXmlAttr(String(v))}\" />`)
    .join('\n');

  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Connect>\n    <Stream url=\"${wsUrl}\">\n${params}\n    </Stream>\n  </Connect>\n</Response>\n`;
}

function requireVoiceWsTokenSecret(): string {
  const secret = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  }
  return secret;
}

function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const token = Buffer.from(raw, 'utf-8').toString('base64');
  return `Basic ${token}`;
}

function makeProviderConfigError(message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = 500;
  (error as any).code = 'provider_config_error';
  return error;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // keep timing roughly consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeUnauthorizedError(message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = 401;
  (error as any).code = 'unauthorized';
  return error;
}

function computeRequestSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map(k => `${k}${params[k] ?? ''}`).join('');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export default class TwilioVoiceCompat {
  async validateWebhookRequest(options: {
    req: http.IncomingMessage;
    url: string;
    params?: Record<string, string>;
    providerDefaults?: any;
  }): Promise<void> {
    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const signatureHeader = options.req?.headers?.['x-twilio-signature'];
    const signature =
      typeof signatureHeader === 'string'
        ? signatureHeader.trim()
        : Array.isArray(signatureHeader)
          ? String(signatureHeader[0] ?? '').trim()
          : '';

    if (!signature) {
      throw makeUnauthorizedError('Unauthorized: missing signature');
    }

    const params = options.params && typeof options.params === 'object' ? options.params : {};
    const expected = computeRequestSignature(authToken, String(options.url), params);
    if (!safeEqual(signature, expected)) {
      throw makeUnauthorizedError('Unauthorized: invalid signature');
    }
  }

  async createWebhookResponse(options: {
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    mediaWsUrl: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const callConfigId = String(options.callConfigId);
    const callConfig = options.callConfig ?? {};
    const to = typeof callConfig.to === 'string' ? callConfig.to : '';
    const from = typeof callConfig.from === 'string' ? callConfig.from : '';
    const direction = String(callConfig.direction ?? '');

    const xml = buildTwiMLConnectStream({
      wsUrl: String(options.mediaWsUrl),
      parameters: {
        callConfigId,
        to,
        from,
        direction
      }
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml
    };
  }

  async handleMediaConnection(options: {
    ws: any;
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    registry: any;
    logger?: any;
    metrics?: any;
  }): Promise<void> {
    const callConfig = options.callConfig ?? {};
    const systemPrompt = callConfig.systemPrompt;
    const realtimeSpec = callConfig.realtimeSpec ?? {};

    const logger = options.logger;
    const safeLog = (level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any) => {
      try {
        const fn = logger?.[level];
        if (typeof fn === 'function') fn(message, data);
      } catch {}
    };
    const metrics = options.metrics;
    const safeMetric = (name: string, ...args: any[]) => {
      try {
        const fn = metrics?.[name];
        if (typeof fn === 'function') fn(...args);
      } catch {}
    };
    const baseFields = {
      callConfigId: String(options.callConfigId),
      voiceProvider: String(options.voiceProvider)
    };

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async ({ metadata }) => {
        const existingMetadataRaw = (realtimeSpec as any)?.metadata;
        const existingMetadata =
          existingMetadataRaw && typeof existingMetadataRaw === 'object' && !Array.isArray(existingMetadataRaw)
            ? existingMetadataRaw
            : {};

        const mergedSpec = {
          ...(realtimeSpec as any),
          ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
          metadata: {
            ...existingMetadata,
            callConfigId: String(options.callConfigId),
            voiceProvider: String(options.voiceProvider),
            providerCallMetadata: metadata
          }
        };
        return await createRealtimeSession(options.registry, mergedSpec);
      },
      security: {
        tokenSecret: requireVoiceWsTokenSecret(),
        tokenMaxTtlSeconds: 86400
      },
      callbacks: {
        onCallStart: (metadata) => {
          safeLog('info', 'voice.media.stream_started', {
            ...baseFields,
            providerStreamId: metadata.streamSid,
            providerCallId: metadata.callSid
          });
        },
        onRealtimeEvent: ({ event, metadata }) => {
          if (event?.type === 'ready') {
            safeLog('info', 'voice.realtime.ready', {
              ...baseFields,
              providerStreamId: metadata.streamSid,
              realtimeSessionId: (event as any).sessionId
            });
          }
        },
        onError: ({ message, code, metadata }) => {
          safeLog('error', 'voice.media.bridge_error', {
            ...baseFields,
            ...(metadata?.streamSid ? { providerStreamId: metadata.streamSid } : {}),
            ...(metadata?.callSid ? { providerCallId: metadata.callSid } : {}),
            code: String(code),
            message: String(message)
          });
          safeMetric('compatError', 'media_bridge', baseFields.voiceProvider);
        }
      }
    });

    await bridge.handleConnection(options.ws, options.req);
  }

  async createOutboundCall(options: {
    to: string;
    from: string;
    callConfigId: string;
    mediaWsUrl: string;
    providerDefaults?: any;
  }): Promise<{ providerCallId: string }> {
    const to = String(options.to ?? '').trim();
    const from = String(options.from ?? '').trim();
    const callConfigId = String(options.callConfigId ?? '').trim();
    if (!to || !from || !callConfigId) {
      const error = new Error('Missing required fields for outbound call');
      (error as any).statusCode = 400;
      (error as any).code = 'validation_error';
      throw error;
    }

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const accountSid = String((defaults as any).accountSid ?? '').trim();
    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!accountSid || !authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';

    const outbound = (defaults as any).outbound ?? {};
    const mode = String(outbound?.mode ?? 'twiml').trim().toLowerCase();
    const outboundTimeoutMsRaw = outbound?.timeoutMs;
    const outboundTimeoutMs =
      outboundTimeoutMsRaw === undefined || outboundTimeoutMsRaw === null || outboundTimeoutMsRaw === ''
        ? 15000
        : Number(outboundTimeoutMsRaw);
    if (!Number.isFinite(outboundTimeoutMs) || outboundTimeoutMs <= 0) {
      throw makeProviderConfigError('Invalid outbound timeoutMs');
    }

    const form = new URLSearchParams();
    form.set('To', to);
    form.set('From', from);

    if (mode === 'url') {
      const baseUrl = String(outbound?.webhookUrl ?? '').trim();
      if (!baseUrl) {
        throw makeProviderConfigError('Missing outbound webhookUrl for url mode');
      }
      const url = new URL(baseUrl);
      url.searchParams.set('callConfigId', callConfigId);
      form.set('Url', url.toString());
    } else if (mode === 'twiml') {
      const twiml = buildTwiMLConnectStream({
        wsUrl: String(options.mediaWsUrl),
        parameters: { callConfigId, to, from, direction: 'outbound' }
      });
      form.set('Twiml', twiml);
    } else {
      throw makeProviderConfigError(`Unsupported outbound mode '${mode}'`);
    }

    const url = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.floor(outboundTimeoutMs));

    let res: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(accountSid, authToken),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: controller.signal
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new ProviderExecutionError('twilio', `Outbound call create timed out after ${Math.floor(outboundTimeoutMs)}ms`, 504);
      }
      const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
      throw new ProviderExecutionError('twilio', `Outbound call create failed${detail}`, 502);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const suffix = text ? `: ${text.slice(0, 500)}` : '';
      throw new ProviderExecutionError('twilio', `Outbound call create failed (${res.status})${suffix}`, res.status, res.status === 429);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new ProviderExecutionError('twilio', 'Malformed response: invalid JSON', res.status);
    }

    const sid = String(data?.sid ?? '').trim();
    if (!sid) {
      throw new ProviderExecutionError('twilio', 'Malformed response: missing sid', res.status);
    }

    return { providerCallId: sid };
  }
}
