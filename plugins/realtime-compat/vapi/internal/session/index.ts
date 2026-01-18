import { createRequire } from 'module';

import type { IRealtimeCompat, RealtimeCompatSession, RealtimeEvent } from '../../../../../kernel/index.js';
import { AsyncQueue } from '../../../../../kernel/index.js';

import { createVapiWebsocketCall, waitForVapiControlUrl } from './internal/api.js';
import { resolveVapiSessionPlan } from './internal/resolve-session.js';
import { generateSessionId } from './internal/settings.js';
import { createVapiSessionState } from './internal/state.js';
import { createVapiSessionApi } from './internal/session-api.js';
import { registerVapiRealtimeWsHandlers } from './internal/ws-handlers.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

export async function createVapiRealtimeCompatSession(
  options: Parameters<IRealtimeCompat['createSession']>[0]
): Promise<RealtimeCompatSession> {
  const plan = resolveVapiSessionPlan(options);
  const endpoint = plan.provider.endpoint;

  const { callId, websocketCallUrl } = await createVapiWebsocketCall({
    url: endpoint.urlTemplate,
    headers: endpoint.headers,
    body: plan.body
  });

  const controlUrlPromise = waitForVapiControlUrl({
    callId,
    urlTemplate: endpoint.urlTemplate,
    headers: endpoint.headers,
    maxWaitMs: plan.controlUrlMaxWaitMs,
    pollMs: plan.controlUrlPollMs
  });

  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const ws: WsLike =
    plan.wsHandshakeTimeoutMs > 0
      ? new wsLib.WebSocket(websocketCallUrl, { handshakeTimeout: plan.wsHandshakeTimeoutMs })
      : new wsLib.WebSocket(websocketCallUrl);
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();
  const state = createVapiSessionState();

  registerVapiRealtimeWsHandlers({
    ws,
    WS_OPEN,
    queue,
    sessionId,
    sessionAudio: plan.sessionAudio,
    spec: plan.spec,
    providerAudio: plan.providerAudio,
    keepaliveEnabled: plan.keepaliveEnabled,
    keepaliveIntervalMs: plan.keepaliveIntervalMs,
    unifiedToolNameByProviderName: plan.unifiedToolNameByProviderName,
    toolsWithMessageParam: plan.toolsWithMessageParam,
    state
  });

  const postControl = async (data: any) => {
    const { controlUrl } = await controlUrlPromise;
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vapi control failed (${res.status}): ${text || res.statusText}`);
    }
  };

  return createVapiSessionApi({
    ws,
    WS_OPEN,
    queue,
    providerAudio: plan.providerAudio,
    toolFallbackDelayMs: plan.toolFallbackDelayMs,
    postControl,
    state
  });
}

