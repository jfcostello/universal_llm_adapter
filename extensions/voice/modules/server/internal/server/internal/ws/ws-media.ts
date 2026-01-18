import type http from 'http';
import type net from 'net';

import { createRequire } from 'module';

import { writeHttpUpgradeResponse } from '../../../../../../../../modules/server/index.js';

import type { VoiceServerContext } from '../core/context.js';
import { asPlainObject } from './utils-ws.js';
import { parseUrl } from '../http/utils-http.js';
import { getMediaWsMaxConcurrentSessions, getMediaWsMaxMessageBytes } from './ws-token.js';
import { handleVoiceMediaUpgradeWithUrlToken } from './ws-media-direct-token.js';
import { handleVoiceMediaUpgradeWithTokenFromMessage } from './ws-media-token-from-message.js';
import type { VoiceMediaWsState } from './ws-media-session.js';

export function createVoiceMediaWs(ctx: VoiceServerContext): {
  handleUpgrade: (ctx: { req: http.IncomingMessage; socket: net.Socket; head: Buffer; pathname: string }) => Promise<boolean>;
  close: () => Promise<void>;
} {
  const require = createRequire(import.meta.url);
  const wsLib = require('ws');

  const mediaWsMaxMessageBytes = getMediaWsMaxMessageBytes();
  const mediaWsMaxConcurrentSessions = getMediaWsMaxConcurrentSessions();
  const wss = new wsLib.WebSocketServer({ noServer: true, maxPayload: mediaWsMaxMessageBytes, perMessageDeflate: false });

  const voiceMediaWsDefaults = asPlainObject((ctx.voiceDefaults as any)?.mediaWs) ?? {};
  const tokenFromMessageTimeoutMs = (() => {
    const raw = (voiceMediaWsDefaults as any)?.tokenFromMessageTimeoutMs;
    if (raw === undefined || raw === null || raw === '') return 5000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 5000;
    const out = Math.floor(n);
    if (out < 0) return 5000;
    return out;
  })();

  const state: VoiceMediaWsState & { draining: boolean } = {
    draining: false,
    activeMediaWs: 0,
    pendingMediaWs: 0
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;

    state.draining = true;
    const clients: any[] = Array.from(wss.clients);
    for (const client of clients) {
      try { client.terminate(); } catch {}
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    state.activeMediaWs = 0;
    state.pendingMediaWs = 0;
  };

  const handleUpgrade = async ({ req, socket, head, pathname }: { req: http.IncomingMessage; socket: net.Socket; head: Buffer; pathname: string }) => {
    if (pathname !== '/voice/media') return false;

    if (state.draining) {
      writeHttpUpgradeResponse(socket, 503, 'Service Unavailable', 'Service Unavailable');
      socket.destroy();
      return true;
    }

    let pendingReserved = false;
    const reservePending = () => {
      pendingReserved = true;
      state.pendingMediaWs += 1;
    };
    const releasePending = () => {
      if (!pendingReserved) return;
      pendingReserved = false;
      state.pendingMediaWs = Math.max(0, state.pendingMediaWs - 1);
    };

    try {
      const url = parseUrl(req.url);
      if (!url) {
        writeHttpUpgradeResponse(socket, 400, 'Bad Request', 'Bad Request');
        socket.destroy();
        return true;
      }

      const urlToken = String(url.searchParams.get('token') ?? '').trim();
      if (urlToken) {
        return await handleVoiceMediaUpgradeWithUrlToken({
          ctx,
          req,
          socket,
          head,
          wss,
          state,
          maxConcurrentSessions: mediaWsMaxConcurrentSessions,
          reservePending,
          releasePending,
          urlToken
        });
      }

      return await handleVoiceMediaUpgradeWithTokenFromMessage({
        ctx,
        req,
        socket,
        head,
        wss,
        state,
        maxConcurrentSessions: mediaWsMaxConcurrentSessions,
        maxMessageBytes: mediaWsMaxMessageBytes,
        tokenFromMessageTimeoutMs,
        reservePending,
        releasePending
      });
    } catch {
      releasePending();
      writeHttpUpgradeResponse(socket, 500, 'Internal Server Error', 'Internal Server Error');
      socket.destroy();
      return true;
    }
  };

  return { handleUpgrade, close };
}
