import type http from 'http';
import type net from 'net';

import { writeHttpUpgradeResponse } from '../../../../../../../../modules/server/index.js';
import { readTrimmedStringProperty } from '../../../../../../../../modules/shared/index.js';

import type { VoiceServerContext } from '../core/context.js';
import { normalizeRequestId, parseUrl } from '../http/utils-http.js';
import { approxWsMessageBytes, findDeepStringValueByKey, tryParseWsMessageJson } from './utils-ws.js';
import { verifyVoiceMediaToken } from './ws-token.js';
import { beginVoiceMediaSession, type VoiceMediaWsState } from './ws-media-session.js';

export async function handleVoiceMediaUpgradeWithTokenFromMessage(options: {
  ctx: VoiceServerContext;
  req: http.IncomingMessage;
  socket: net.Socket;
  head: Buffer;
  wss: any;
  state: VoiceMediaWsState;
  maxConcurrentSessions: number;
  maxMessageBytes: number;
  tokenFromMessageTimeoutMs: number;
  reservePending: () => void;
  releasePending: () => void;
}): Promise<boolean> {
  // Some providers cannot preserve WS URL query parameters. Allow the token to be provided
  // via the first WS message (e.g. `voiceMediaToken`) before delegating to the compat.
  if (options.tokenFromMessageTimeoutMs <= 0) {
    writeHttpUpgradeResponse(options.socket, 401, 'Unauthorized', 'Unauthorized');
    options.socket.destroy();
    return true;
  }

  if (options.state.activeMediaWs + options.state.pendingMediaWs >= options.maxConcurrentSessions) {
    writeHttpUpgradeResponse(options.socket, 503, 'Service Unavailable', 'Service Unavailable');
    options.socket.destroy();
    return true;
  }

  options.reservePending();

  options.wss.handleUpgrade(options.req, options.socket, options.head, (ws: any) => {
    const tokenKey = 'voiceMediaToken';
    const maxDepth = 8;
    const maxBufferedBytes = Math.min(256 * 1024, Math.max(0, Math.floor(options.maxMessageBytes)));

    let buffered: any[][] = [];
    let bufferedBytes = 0;
    let bufferFlushed = false;
    let bufferingEnabled = true;

    const messageListeners: Array<(...args: any[]) => void> = [];

    let tokenResolved = false;
    let resolveToken: ((token: string) => void) | undefined;
    let rejectToken: ((error: any) => void) | undefined;
    const tokenPromise = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    const closeWith = (code: number, reason: string) => {
      try { ws.close(code, reason); } catch {}
    };

    const timeout = setTimeout(() => {
      closeWith(1008, 'Unauthorized');
      rejectToken?.(new Error('missing_ws_token'));
    }, Math.floor(options.tokenFromMessageTimeoutMs));
    if (typeof (timeout as any)?.unref === 'function') {
      (timeout as any).unref();
    }

    const flushBufferTo = (cb: (...args: any[]) => void) => {
      if (bufferFlushed) return;
      bufferFlushed = true;
      bufferingEnabled = false;
      const items = buffered;
      buffered = [];
      bufferedBytes = 0;
      for (const args of items) {
        try { cb(...args); } catch {}
      }
    };

    const wsProxy: any = {
      get readyState() {
        return ws.readyState;
      },
      send: (...args: any[]) => ws.send(...args),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      terminate: () => ws.terminate?.(),
      on: (event: string, cb: (...args: any[]) => void) => {
        if (event === 'message') {
          messageListeners.push(cb);
          flushBufferTo(cb);
          return wsProxy;
        }
        ws.on?.(event, cb);
        return wsProxy;
      },
      off: (event: string, cb: (...args: any[]) => void) => {
        if (event === 'message') {
          const idx = messageListeners.indexOf(cb);
          if (idx >= 0) messageListeners.splice(idx, 1);
          return wsProxy;
        }
        ws.off?.(event, cb);
        return wsProxy;
      },
      once: (event: string, cb: (...args: any[]) => void) => {
        if (event === 'message') {
          const wrapper = (...args: any[]) => {
            wsProxy.off('message', wrapper);
            cb(...args);
          };
          wsProxy.on('message', wrapper);
          return wsProxy;
        }
        ws.once?.(event, cb);
        return wsProxy;
      },
      emit: (...args: any[]) => ws.emit?.(...args)
    };

    const onMessage = (...args: any[]) => {
      const data = args[0];

      if (bufferingEnabled) {
        buffered.push(args);
        bufferedBytes += approxWsMessageBytes(data);
        if (bufferedBytes > maxBufferedBytes) {
          closeWith(1009, 'Message too large');
          return;
        }
      }

      if (messageListeners.length > 0) {
        for (const cb of messageListeners) {
          try { cb(...args); } catch {}
        }
      }

      if (!tokenResolved) {
        const parsed = tryParseWsMessageJson(data);
        const token = parsed
          ? findDeepStringValueByKey({ value: parsed, key: tokenKey, maxDepth })
          : undefined;
        if (token) {
          tokenResolved = true;
          clearTimeout(timeout);
          resolveToken?.(token);
        }
      }
    };

    ws.on?.('message', onMessage);
    ws.on?.('close', () => {
      clearTimeout(timeout);
      rejectToken?.(new Error('ws_closed'));
    });
    ws.on?.('error', (err: any) => {
      clearTimeout(timeout);
      rejectToken?.(err ?? new Error('ws_error'));
    });

    void (async () => {
      let token: string;
      try {
        token = await tokenPromise;
      } catch {
        options.releasePending();
        return;
      }

      const verified = verifyVoiceMediaToken(token);
      if (!verified.ok) {
        options.releasePending();
        closeWith(1008, 'Unauthorized');
        return;
      }

      const { callConfigId, voiceProvider, nonce, exp } = verified.payload;

      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttlSeconds = Math.max(1, Math.ceil(exp - nowSeconds));
      const nonceOk = await options.ctx.store.consumeNonceOnce(nonce, { ttlSeconds });
      if (!nonceOk) {
        const logger = await options.ctx.resolveLogger(callConfigId);
        options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'nonce_replay' });
        options.releasePending();
        closeWith(1008, 'Unauthorized');
        return;
      }

      const callConfig = await options.ctx.store.getConfig(callConfigId);
      if (!callConfig) {
        const logger = await options.ctx.resolveLogger(callConfigId);
        options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'unknown_call_config' });
        options.releasePending();
        closeWith(1008, 'Not Found');
        return;
      }

      const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
      const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

      if (String((callConfig as any).voiceProvider ?? '') !== voiceProvider) {
        const logger = await options.ctx.resolveLogger(callConfigId);
        options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'voice_provider_mismatch' });
        options.releasePending();
        closeWith(1008, 'Unauthorized');
        return;
      }

      const logger = await options.ctx.resolveLogger(callConfigId);
      const compat = await options.ctx.providerPlugins.getCompat(voiceProvider);
      let providerDefaults: any | undefined;
      try {
        const manifest = await options.ctx.providerPlugins.getManifest?.(voiceProvider);
        providerDefaults = (manifest as any)?.defaults;
      } catch {}

      // Ensure downstream compats that verify the token via `req.url` still work.
      const injected = parseUrl(options.req.url) ?? new URL('/voice/media', 'http://localhost');
      injected.searchParams.set('token', token);
      options.req.url = `${injected.pathname}${injected.search}`;

      beginVoiceMediaSession({
        state: options.state,
        releasePending: options.releasePending,
        wsReal: ws,
        wsForCompat: wsProxy,
        req: options.req,
        callConfigId,
        callConfig,
        voiceProvider,
        requestId,
        logger,
        compat,
        providerDefaults,
        registry: options.ctx.registry,
        store: options.ctx.store,
        emitCallEvent: options.ctx.emitCallEvent,
        metrics: options.ctx.metrics,
        safeLog: options.ctx.safeLog
      });
    })().catch(() => {
      options.releasePending();
      closeWith(1011, 'Internal Error');
    });
  });

  return true;
}
