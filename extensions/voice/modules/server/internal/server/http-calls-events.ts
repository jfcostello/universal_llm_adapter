import type http from 'http';

import { normalizeFlag } from '../../../../../../modules/shared/index.js';

import type { VoiceCallEventEnvelope } from '../../../call-events/index.js';
import { StringChunkQueue } from '../../../shared/index.js';

import type { VoiceServerContext } from './context.js';
import { writeJson } from './utils-http.js';

export async function handleVoiceCallsEvents(
  ctx: VoiceServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  const callPathParts = url.pathname.split('/').filter(Boolean);

  if (
    !(
      callPathParts.length === 4 &&
      callPathParts[0] === 'voice' &&
      callPathParts[1] === 'calls' &&
      callPathParts[2] &&
      callPathParts[3] === 'events'
    )
  ) {
    return false;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
    return true;
  }

  if (!ctx.authConfig || ctx.authConfig.mode === 'none') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice call events endpoint requires server auth to be enabled', code: 'not_implemented' } });
    return true;
  }

  await ctx.assertAuthorizedAndRateLimited(req);

  const callConfigId = String(callPathParts[2]).trim();
  const callConfig = await ctx.store.getConfig(callConfigId);
  if (!callConfig) {
    writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
    return true;
  }

  const includeDeltasRaw = url.searchParams.get('includeDeltas');
  const includeDeltas = includeDeltasRaw === null
    ? ctx.eventsDefaultIncludeDeltas
    : normalizeFlag(includeDeltasRaw, ctx.eventsDefaultIncludeDeltas);

  const eventTypes = (() => {
    const raw = String(url.searchParams.get('eventTypes') ?? '').trim();
    if (!raw) return undefined;
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts.slice(0, 100) : undefined;
  })();

  const sanitizeEventName = (value: string): string =>
    String(value ?? '')
      .replace(/[\r\n]/g, '')
      .trim()
      .slice(0, 128) || 'message';

  let closed = false;
  let keepAliveTimer: any | undefined;
  let sub: { accepted: boolean; replay: VoiceCallEventEnvelope[]; unsubscribe: () => void } | undefined;
  let drainingWrites = false;
  let inFlightBytes = 0;
  const queuedChunks = new StringChunkQueue();
  const queuedEnvelopes: VoiceCallEventEnvelope[] = [];
  let canWriteEvents = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { if (keepAliveTimer) clearInterval(keepAliveTimer); } catch {}
    try { sub?.unsubscribe(); } catch {}
    try { res.off?.('drain', onDrain); } catch {}
  };

  const closeResponse = () => {
    cleanup();
    try { res.end(); } catch {}
  };

  const checkQueueLimit = () => {
    const pendingBytes = inFlightBytes + queuedChunks.byteLength();
    if (pendingBytes <= ctx.eventsMaxWriteQueueBytes) return;
    closeResponse();
  };

  const attachDrain = () => {
    res.on?.('drain', onDrain);
  };

  const flushQueued = () => {
    while (true) {
      const next = queuedChunks.shift();
      if (!next) break;
      const { chunk, bytes } = next;
      try {
        const ok = res.write(chunk);
        if (ok === false) {
          drainingWrites = true;
          inFlightBytes = bytes;
          attachDrain();
          checkQueueLimit();
          return;
        }
      } catch {
        closeResponse();
        return;
      }
    }
  };

  function onDrain() {
    if (closed) return;
    drainingWrites = false;
    inFlightBytes = 0;
    try {
      res.off?.('drain', onDrain);
    } catch {}
    flushQueued();
  }

  const writeChunk = (chunk: string) => {
    if (closed) return;

    if (drainingWrites) {
      queuedChunks.push(chunk);
      checkQueueLimit();
      return;
    }

    try {
      const ok = res.write(chunk);
      if (ok === false) {
        drainingWrites = true;
        inFlightBytes = Buffer.byteLength(chunk, 'utf8');
        attachDrain();
        checkQueueLimit();
      }
    } catch {
      closeResponse();
    }
  };

  const writeEvent = (envelope: VoiceCallEventEnvelope) => {
    if (!canWriteEvents) {
      queuedEnvelopes.push(envelope);
      return;
    }
    try {
      const name = sanitizeEventName(envelope.event?.type);
      const data = JSON.stringify(envelope);
      writeChunk(`event: ${name}\ndata: ${data}\n\n`);
    } catch {}
  };

  sub = ctx.eventsHub.subscribe(callConfigId, { includeDeltas, ...(eventTypes ? { eventTypes } : {}) }, (evt) => writeEvent(evt));
  if (!sub.accepted) {
    writeJson(res, 503, {
      type: 'error',
      error: { message: 'Voice call events hub is saturated', code: 'call_events_saturated' }
    });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  canWriteEvents = true;

  for (const evt of sub.replay) {
    writeEvent(evt);
  }
  for (const evt of queuedEnvelopes) {
    writeEvent(evt);
  }
  queuedEnvelopes.length = 0;

  if (closed) return true;

  if (ctx.eventsKeepAliveIntervalMs > 0) {
    keepAliveTimer = setInterval(() => {
      writeChunk(': keepalive\n\n');
    }, ctx.eventsKeepAliveIntervalMs);
    if (typeof (keepAliveTimer as any)?.unref === 'function') {
      (keepAliveTimer as any).unref();
    }
  }

  req.on?.('close', cleanup);
  res.on?.('close', cleanup);
  res.on?.('error', cleanup);

  return true;
}

