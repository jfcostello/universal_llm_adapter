import type http from 'http';
import type net from 'net';
import crypto from 'crypto';
import { createRequire } from 'module';

import { mapErrorToHttp } from '../../../modules/transport/index.js';
import { createSignedWsToken, verifySignedWsToken } from '../../../modules/security/index.js';
import { writeHttpUpgradeResponse } from '../../../modules/server/internal/transport/upgrade-router.js';

import type { VoiceProviderPlugins } from './provider-plugins.js';
import { createVoiceProviderPlugins } from './provider-plugins.js';
import type { VoiceCallConfigStore } from './call-config-store/index.js';
import { createInMemoryVoiceCallConfigStore } from './call-config-store/index.js';

type VoiceMediaTokenPayload = {
  iat: number;
  exp: number;
  nonce: string;
  purpose: 'voice_media';
  callConfigId: string;
  voiceProvider: string;
};

function parseUrl(rawUrl: string | undefined): URL | null {
  const raw = rawUrl ?? '/';
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return null;
  }
}

function getPublicHttpBaseUrl(req: http.IncomingMessage): string {
  const headers = req.headers ?? {};
  const forwardedProto = headers['x-forwarded-proto'];
  const proto =
    typeof forwardedProto === 'string' && forwardedProto.trim()
      ? forwardedProto.split(',')[0]!.trim()
      : (req.socket as any)?.encrypted
        ? 'https'
        : 'http';

  const forwardedHost = headers['x-forwarded-host'];
  const host =
    typeof forwardedHost === 'string' && forwardedHost.trim()
      ? forwardedHost.split(',')[0]!.trim()
      : typeof headers.host === 'string' && headers.host.trim()
        ? headers.host.trim()
        : 'localhost';

  return `${proto}://${host}`;
}

function toWsUrl(httpBaseUrl: string, pathname: string, searchParams: Record<string, string>): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = '';
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function getWsTokenSecret(): string {
  const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim();
  if (!raw) {
    throw new Error('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  }
  return raw;
}

function getWsTokenTtlSeconds(): number {
  const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS ?? '').trim();
  if (!raw) return 300;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS');
  }
  return Math.floor(n);
}

function mintVoiceMediaToken(options: { callConfigId: string; voiceProvider: string }): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = getWsTokenTtlSeconds();
  const payload: VoiceMediaTokenPayload = {
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce: crypto.randomBytes(18).toString('base64url'),
    purpose: 'voice_media',
    callConfigId: String(options.callConfigId),
    voiceProvider: String(options.voiceProvider)
  };
  return createSignedWsToken({ secret: getWsTokenSecret(), payload });
}

function verifyVoiceMediaToken(token: string): { ok: true; payload: VoiceMediaTokenPayload } | { ok: false; error: any } {
  const res = verifySignedWsToken<VoiceMediaTokenPayload>({
    token,
    secret: getWsTokenSecret(),
    expected: { purpose: 'voice_media' }
  });
  if (!res.ok) return res;

  const callConfigId = String((res.payload as any).callConfigId ?? '').trim();
  const voiceProvider = String((res.payload as any).voiceProvider ?? '').trim();
  if (!callConfigId || !voiceProvider) {
    return { ok: false, error: { code: 'missing_fields', message: 'Token payload missing required fields' } };
  }

  return { ok: true, payload: { ...(res.payload as any), callConfigId, voiceProvider } as VoiceMediaTokenPayload };
}

function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function createVoiceServerRegistration(ctx: {
  server: http.Server;
  registry: any;
  pluginsPath: string;
  upgradeRouter: any;
  store?: VoiceCallConfigStore;
  providerPlugins?: VoiceProviderPlugins;
}): Promise<{
  handleHttp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  handleUpgrade: (ctx: { req: http.IncomingMessage; socket: net.Socket; head: Buffer; pathname: string }) => Promise<boolean>;
  close: () => Promise<void>;
}> {
  const store = ctx.store ?? createInMemoryVoiceCallConfigStore();
  const providerPlugins = ctx.providerPlugins ?? createVoiceProviderPlugins({ pluginsPath: ctx.pluginsPath });

  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const wss = new wsLib.WebSocketServer({ noServer: true });

  const close = async () => {
    const clients: any[] = Array.from(wss.clients);
    for (const client of clients) {
      try { client.terminate(); } catch {}
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return {
    handleHttp: async (req, res) => {
      const url = parseUrl(req.url);
      if (!url) return false;

      const pathname = url.pathname;
      if (pathname !== '/voice' && !pathname.startsWith('/voice/')) return false;

      try {
        if (pathname === '/voice/webhook') {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'POST') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          const callConfigId = String(url.searchParams.get('callConfigId') ?? '').trim();
          if (!callConfigId) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing callConfigId', code: 'validation_error' } });
            return true;
          }

          const callConfig = await store.getConfig(callConfigId);
          if (!callConfig) {
            writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
            return true;
          }

          const voiceProvider = String((callConfig as any).voiceProvider ?? '').trim();
          if (!voiceProvider) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
            return true;
          }

          const httpBaseUrl = getPublicHttpBaseUrl(req);
          const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
          const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });

          const compat = await providerPlugins.getCompat(voiceProvider);
          const response = await compat.createWebhookResponse({ req, callConfigId, callConfig, voiceProvider, mediaWsUrl });
          const status = Number(response?.status ?? 200);
          const headers = (response?.headers && typeof response.headers === 'object') ? response.headers : {};
          const body = String(response?.body ?? '');

          res.writeHead(status, headers);
          res.end(body);
          return true;
        }

        if (pathname === '/voice' || pathname === '/voice/') {
          writeJson(res, 200, { ok: true });
          return true;
        }

        writeJson(res, 404, { type: 'error', error: { message: 'Not found', code: 'not_found' } });
        return true;
      } catch (err: any) {
        const mapped = mapErrorToHttp(err);
        writeJson(res, mapped.status, mapped.body);
        return true;
      }
    },

    handleUpgrade: async ({ req, socket, head, pathname }) => {
      if (pathname !== '/voice/media') return false;

      const url = parseUrl(req.url);
      if (!url) {
        writeHttpUpgradeResponse(socket, 400, 'Bad Request', 'Bad Request');
        socket.destroy();
        return true;
      }

      const token = String(url.searchParams.get('token') ?? '').trim();
      const verified = verifyVoiceMediaToken(token);
      if (!verified.ok) {
        writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
        socket.destroy();
        return true;
      }

      const { callConfigId, voiceProvider, nonce, exp } = verified.payload;

      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttlSeconds = Math.max(1, Math.ceil(exp - nowSeconds));
      const nonceOk = await store.consumeNonceOnce(nonce, { ttlSeconds });
      if (!nonceOk) {
        writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
        socket.destroy();
        return true;
      }

      const callConfig = await store.getConfig(callConfigId);
      if (!callConfig) {
        writeHttpUpgradeResponse(socket, 404, 'Not Found', 'Not Found');
        socket.destroy();
        return true;
      }

      if (String((callConfig as any).voiceProvider ?? '') !== voiceProvider) {
        writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
        socket.destroy();
        return true;
      }

      const compat = await providerPlugins.getCompat(voiceProvider);

      wss.handleUpgrade(req, socket, head, (ws: any) => {
        void Promise.resolve()
          .then(() => compat.handleMediaConnection({ ws, req, callConfigId, callConfig, voiceProvider, registry: ctx.registry, store }))
          .catch(() => {
            try { ws.close(); } catch {}
          });
      });
      return true;
    },

    close
  };
}
