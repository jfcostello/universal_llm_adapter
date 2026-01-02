import type { RealtimeAudioFrame, RealtimeEvent } from '../../../../kernel/index.js';
import type { RealtimeSession } from '../../../../modules/realtime/index.js';
import { AudioPacer, base64ToBytes, bytesToBase64, durationMsForBytes } from '../../../../modules/audio/index.js';
import { verifySignedWsToken } from '../../../../modules/security/index.js';
import { createAudioRateLimiter } from '../../../../modules/server/index.js';

import { convertAudioBytes, frameAudioBytes, type AudioSpec } from './audio.js';
import {
  buildTwilioClearMessage,
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioInboundMessage
} from './messages.js';

export type TwilioRequestLike = { url?: string | undefined };

export type TwilioMediaStreamsWsLike = {
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: 'message' | 'close' | 'error', cb: (...args: any[]) => void) => void;
};

export interface TwilioCallMetadata {
  streamSid: string;
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  customParameters: Record<string, string>;
}

export interface TwilioMediaStreamsBridgeLimits {
  maxWsMessageBytes?: number;
  maxAudioBytesPerSecond?: number;
  idleTimeoutMs?: number;
  maxSessionDurationMs?: number;
  startTimeoutMs?: number;
  maxPendingInboundFrames?: number;
  maxPendingOutboundAudioMs?: number;
  firstTurnGraceMs?: number;
}

export interface TwilioMediaStreamsBridgeAudioOptions {
  frameMs?: number;
  markEveryMs?: number;
  pacing?: {
    enabled?: boolean;
    pacer?: Pick<AudioPacer, 'paceBytes' | 'reset'>;
  };
}

export interface TwilioMediaStreamsBridgeSecurity {
  tokenParam?: string;
  tokenSecret: string;
  tokenMaxTtlSeconds?: number;
  tokenClockSkewSeconds?: number;
  allowedAccountSids?: string[];
  expectedTokenPayload?: Record<string, unknown>;
}

export interface TwilioMediaStreamsBridgeCallbacks {
  onCallStart?: (metadata: TwilioCallMetadata) => void;
  onDtmf?: (options: { digit: string; metadata: TwilioCallMetadata }) => void;
  onMark?: (options: { name: string; metadata: TwilioCallMetadata; kind?: 'periodic' | 'drain'; playedMs?: number }) => void;
  onRealtimeEvent?: (options: { event: RealtimeEvent; metadata: TwilioCallMetadata }) => void;
  onError?: (options: { message: string; code?: string; metadata?: TwilioCallMetadata }) => void;
}

export interface TwilioMediaStreamsBridgeOptions {
  createSession: (options: { metadata: TwilioCallMetadata }) => Promise<RealtimeSession> | RealtimeSession;
  security: TwilioMediaStreamsBridgeSecurity;
  limits?: TwilioMediaStreamsBridgeLimits;
  audio?: TwilioMediaStreamsBridgeAudioOptions;
  callbacks?: TwilioMediaStreamsBridgeCallbacks;
}

export interface TwilioMediaStreamsBridge {
  handleConnection: (ws: TwilioMediaStreamsWsLike, req: TwilioRequestLike) => Promise<void>;
}

const DEFAULT_LIMITS: Required<TwilioMediaStreamsBridgeLimits> = {
  maxWsMessageBytes: 262144,
  maxAudioBytesPerSecond: 256000,
  idleTimeoutMs: 60000,
  maxSessionDurationMs: 3600000,
  startTimeoutMs: 5000,
  maxPendingInboundFrames: 200,
  maxPendingOutboundAudioMs: 10000,
  firstTurnGraceMs: 0
};

const DEFAULT_AUDIO: Required<Pick<TwilioMediaStreamsBridgeAudioOptions, 'frameMs' | 'markEveryMs'>> = {
  frameMs: 20,
  markEveryMs: 200
};

function parseUrl(urlLike: string | undefined): URL {
  const raw = String(urlLike ?? '/');
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    // best-effort
    return new URL('http://localhost/');
  }
}

function approxBytesFromBase64(base64: string): number {
  const len = Math.max(0, base64.length);
  return Math.floor((len * 3) / 4);
}

function sanitizeCustomParameters(value: any): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (String(k).toLowerCase() === 'voicemediatoken') continue;
    if (typeof v === 'string') out[String(k)] = v;
    else if (v === null || v === undefined) continue;
    else out[String(k)] = String(v);
  }
  return out;
}

function pickFirstString(custom: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const v = custom[key];
    if (typeof v === 'string' && v) return v;
    const alt = custom[key.toLowerCase()];
    if (typeof alt === 'string' && alt) return alt;
    const alt2 = custom[key.toUpperCase()];
    if (typeof alt2 === 'string' && alt2) return alt2;
  }
  return '';
}

function getDirection(custom: Record<string, string>): 'inbound' | 'outbound' {
  const raw = pickFirstString(custom, ['direction', 'callDirection']).toLowerCase();
  return raw === 'outbound' ? 'outbound' : 'inbound';
}

function extractMetadata(options: {
  streamSid: string;
  start: any;
}): TwilioCallMetadata {
  const start = options.start;
  const customParameters = sanitizeCustomParameters(start.customParameters);
  const from = pickFirstString(customParameters, ['from', 'From']);
  const to = pickFirstString(customParameters, ['to', 'To']);
  return {
    streamSid: options.streamSid,
    callSid: String(start.callSid ?? ''),
    accountSid: String(start.accountSid ?? ''),
    from,
    to,
    direction: getDirection(customParameters),
    customParameters
  };
}

function ensureSendable(ws: TwilioMediaStreamsWsLike): void {
  const state = ws.readyState;
  // WebSocket.OPEN is 1 in `ws`, but we avoid depending on the library.
  if (state !== undefined && state !== 1) {
    throw new Error('WebSocket not open');
  }
}

function safeClose(ws: TwilioMediaStreamsWsLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {}
}

class ResettableQueue<T> {
  private queue: T[] = [];
  private waiting: Array<(value: T | null) => void> = [];
  private closed = false;
  private generation = 0;

  push(item: T) {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) next(item);
    else this.queue.push(item);
  }

  size(): number {
    return this.queue.length;
  }

  currentGeneration(): number {
    return this.generation;
  }

  async next(): Promise<{ value: T; generation: number } | null> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, generation: this.generation };
    }
    if (this.closed) return null;
    return await new Promise(resolve => {
      this.waiting.push((value) => {
        if (value === null) resolve(null);
        else resolve({ value, generation: this.generation });
      });
    });
  }

  clear() {
    this.queue = [];
    this.generation++;
  }

  close() {
    this.closed = true;
    for (const fn of this.waiting.splice(0, this.waiting.length)) fn(null);
    this.queue = [];
  }
}

type OutboundItem =
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'mark'; name: string; markKind: 'periodic' | 'drain' };

export function createTwilioMediaStreamsBridge(options: TwilioMediaStreamsBridgeOptions): TwilioMediaStreamsBridge {
  const limits: Required<TwilioMediaStreamsBridgeLimits> = {
    ...DEFAULT_LIMITS,
    ...(options.limits ?? {})
  };
  const audioCfg = options.audio ?? {};
  const frameMs = Math.max(1, Math.floor(audioCfg.frameMs ?? DEFAULT_AUDIO.frameMs));
  const markEveryMs = Math.max(1, Math.floor(audioCfg.markEveryMs ?? DEFAULT_AUDIO.markEveryMs));
  const pacer = audioCfg.pacing?.pacer ?? new AudioPacer();
  const pacingEnabled = audioCfg.pacing?.enabled !== false;

  const tokenParam = options.security.tokenParam ?? 'token';
  const tokenSecret = String(options.security.tokenSecret ?? '');
  if (!tokenSecret) {
    throw new Error('Twilio bridge requires tokenSecret');
  }

  const maxTtlSeconds = options.security.tokenMaxTtlSeconds ?? 300;
  const clockSkewSeconds = options.security.tokenClockSkewSeconds ?? 5;
  const allowedAccountSids = options.security.allowedAccountSids ?? [];

  return {
    async handleConnection(ws: TwilioMediaStreamsWsLike, req: TwilioRequestLike): Promise<void> {
      // Reject missing/invalid token before accepting any WS messages.
      const url = parseUrl(req.url);
      const token = url.searchParams.get(tokenParam) ?? '';
      const verified = verifySignedWsToken({
        token,
        secret: tokenSecret,
        maxTtlSeconds: maxTtlSeconds,
        clockSkewSeconds: clockSkewSeconds,
        expected: options.security.expectedTokenPayload
      });
      if (!verified.ok) {
        safeClose(ws, 1008, 'Unauthorized');
        return;
      }

      const rateLimiter = createAudioRateLimiter(limits.maxAudioBytesPerSecond);

      let idleTimer: any | undefined;
      let durationTimer: any | undefined;
      let startTimer: any | undefined;
      let firstTurnGraceTimer: any | undefined;

      let closed = false;
      let metadata: TwilioCallMetadata | undefined;

      let session: RealtimeSession | undefined;
      let sessionReadyAudioInput: AudioSpec | undefined;
      let sessionReadyAudioOutput: AudioSpec | undefined;

      const inboundAudioQueue = new ResettableQueue<RealtimeAudioFrame>();
      const outboundAudioQueue = new ResettableQueue<OutboundItem>();
      const dtmfQueue = new ResettableQueue<string>();

      let sentAudioMsTotal = 0;
      let markSeq = 0;
      let drainSeq = 0;
      let pendingMarkMs = 0;
      let playedMs: number | undefined;
      const markToMs = new Map<string, number>();
      const markKindByName = new Map<string, 'periodic' | 'drain'>();

      let pendingUserSpeech = false;

      const callbacks = options.callbacks ?? {};

      const touch = () => {
        if (!Number.isFinite(limits.idleTimeoutMs) || limits.idleTimeoutMs <= 0) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          callbacks.onError?.({ message: 'WS idle timeout', code: 'ws_idle_timeout', metadata });
          safeClose(ws, 1000, 'Idle timeout');
        }, limits.idleTimeoutMs);
      };

      const closeAll = async () => {
        if (closed) return;
        closed = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (durationTimer) clearTimeout(durationTimer);
        if (startTimer) clearTimeout(startTimer);
        clearTimeout(firstTurnGraceTimer);
        firstTurnGraceTimer = undefined;

        inboundAudioQueue.close();
        outboundAudioQueue.close();
        dtmfQueue.close();
        try { await session?.close?.(); } catch {}
        try { safeClose(ws, 1000, 'Closed'); } catch {}
      };

      const sendJson = (obj: any) => {
        if (closed) return;
        try {
          ensureSendable(ws);
          touch();
          ws.send(JSON.stringify(obj));
        } catch (err: any) {
          callbacks.onError?.({ message: err?.message ?? String(err), code: 'ws_send_failed', metadata });
          void closeAll();
        }
      };

      const clearPlayback = (call: TwilioCallMetadata) => {
        outboundAudioQueue.clear();
        pacer.reset();

        sentAudioMsTotal = 0;
        pendingMarkMs = 0;
        markSeq = 0;
        drainSeq = 0;
        playedMs = undefined;
        markToMs.clear();
        markKindByName.clear();

        sendJson(buildTwilioClearMessage({ streamSid: call.streamSid }));
      };

      const startOutboundPump = (call: TwilioCallMetadata) => {
        void (async () => {
          while (true) {
            const next = await outboundAudioQueue.next();
            if (!next) return;

            const { value, generation } = next;

            if (generation !== outboundAudioQueue.currentGeneration()) {
              continue;
            }

            if (value.kind === 'mark') {
              markToMs.set(value.name, sentAudioMsTotal);
              markKindByName.set(value.name, value.markKind);
              sendJson(buildTwilioMarkMessage({ streamSid: call.streamSid, name: value.name }));
              continue;
            }

            const bytes = value.bytes;

            // Any clear interrupts in-flight frames as well as queued frames.
            if (pacingEnabled) {
              await pacer.paceBytes({
                format: 'g711_ulaw',
                sampleRateHz: 8000,
                channels: 1,
                byteLength: bytes.length
              });
            }

            if (generation !== outboundAudioQueue.currentGeneration()) {
              continue;
            }

            const payloadBase64 = bytesToBase64(bytes);
            sendJson(buildTwilioMediaMessage({ streamSid: call.streamSid, payloadBase64 }));

            // Mark tracking for playback progress.
            const durMs = durationMsForBytes({
              format: 'g711_ulaw',
              sampleRateHz: 8000,
              channels: 1,
              byteLength: bytes.length
            });
            sentAudioMsTotal += durMs;
            pendingMarkMs += durMs;
            if (pendingMarkMs >= markEveryMs) {
              const name = `m${++markSeq}`;
              markToMs.set(name, sentAudioMsTotal);
              markKindByName.set(name, 'periodic');
              pendingMarkMs = 0;
              sendJson(buildTwilioMarkMessage({ streamSid: call.streamSid, name }));
            }
          }
        })();
      };

      const startInboundPump = (localSession: RealtimeSession) => {
        void (async () => {
          while (true) {
            const next = await inboundAudioQueue.next();
            if (!next) return;
            try {
              const target = sessionReadyAudioInput;
              if (target) {
                const frame = next.value;
                const inputSpec: AudioSpec = {
                  format: frame.format as AudioSpec['format'],
                  sampleRateHz: Number(frame.sampleRateHz),
                  channels: frame.channels as 1 | 2
                };

                const sameFormat = inputSpec.format === target.format;
                const sameRate = Math.floor(inputSpec.sampleRateHz) === Math.floor(target.sampleRateHz);
                const sameCh = inputSpec.channels === target.channels;

                if (!sameFormat || !sameRate || !sameCh) {
                  const inputBytes = base64ToBytes(frame.dataBase64);
                  const converted = convertAudioBytes({ input: inputBytes, inputSpec, outputSpec: target });
                  const outBase64 = bytesToBase64(converted);
                  await localSession.sendAudio({
                    format: target.format as any,
                    sampleRateHz: target.sampleRateHz,
                    channels: target.channels,
                    dataBase64: outBase64
                  });
                  continue;
                }
              }

              await localSession.sendAudio(next.value);
            } catch (err: any) {
              callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_send_audio_failed', metadata });
              void closeAll();
              return;
            }
          }
        })();
      };

      const startDtmfPump = (localSession: RealtimeSession) => {
        void (async () => {
          while (true) {
            const next = await dtmfQueue.next();
            if (!next) return;
            try {
              await localSession.sendDTMF(next.value);
            } catch (err: any) {
              callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_send_dtmf_failed', metadata });
              void closeAll();
              return;
            }
          }
        })();
      };

      const startSessionPump = (localSession: RealtimeSession, call: TwilioCallMetadata) => {
        void (async () => {
          try {
            const iter = localSession.events()[Symbol.asyncIterator]();
            const first = await iter.next();
            if (first.done || first.value?.type !== 'ready') {
              throw new Error('Realtime session did not emit ready first');
            }

            const ready = first.value as Extract<RealtimeEvent, { type: 'ready' }>;
            const inCfg = ready.audio?.input ?? { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 };
            const outCfg = ready.audio?.output ?? { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 };

            sessionReadyAudioInput = {
              format: inCfg.format as AudioSpec['format'],
              sampleRateHz: Number(inCfg.sampleRateHz ?? 8000),
              channels: (inCfg.channels ?? 1) as 1 | 2
            };
            sessionReadyAudioOutput = {
              format: outCfg.format as AudioSpec['format'],
              sampleRateHz: Number(outCfg.sampleRateHz ?? 8000),
              channels: (outCfg.channels ?? 1) as 1 | 2
            };

            // Start pumps once the session is ready.
            startInboundPump(localSession);
            startOutboundPump(call);
            startDtmfPump(localSession);

            callbacks.onRealtimeEvent?.({ event: first.value, metadata: call });

            const firstTurnGraceMs = Math.max(0, Math.floor(Number(limits.firstTurnGraceMs ?? 0)));
            const readyAtMs = Date.now();
            const firstTurnGraceEndsAtMs = firstTurnGraceMs > 0 ? readyAtMs + firstTurnGraceMs : 0;
            let firstAutoCommitDone = false;
            let sawUserSpeechStarted = false;

            const scheduleCommitAfterGrace = () => {
              const delay = Math.max(0, firstTurnGraceEndsAtMs - Date.now());
              clearTimeout(firstTurnGraceTimer);
              firstTurnGraceTimer = setTimeout(() => {
                firstTurnGraceTimer = undefined;
                void (async () => {
                  try {
                    await localSession.commit();
                    firstAutoCommitDone = true;
                  } catch (err: any) {
                    callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_commit_failed', metadata });
                    void closeAll();
                  }
                })();
              }, delay);
              if (typeof (firstTurnGraceTimer as any)?.unref === 'function') {
                try {
                  (firstTurnGraceTimer as any).unref();
                } catch {}
              }
            };

            for await (const event of { [Symbol.asyncIterator]: () => iter } as AsyncIterable<RealtimeEvent>) {
              const inGrace = Boolean(firstTurnGraceEndsAtMs) && Date.now() < firstTurnGraceEndsAtMs && !firstAutoCommitDone;
              const suppressUserTranscripts =
                inGrace &&
                !sawUserSpeechStarted &&
                (event.type === 'user_transcript.delta' || event.type === 'user_transcript.final');

              if (!suppressUserTranscripts) {
                callbacks.onRealtimeEvent?.({ event, metadata: call });
              }

              if (event.type === 'user_speech.started') {
                pendingUserSpeech = true;
                if (inGrace) sawUserSpeechStarted = true;
                if (inGrace) {
                  clearTimeout(firstTurnGraceTimer);
                  firstTurnGraceTimer = undefined;
                }
              } else if (event.type === 'user_speech.stopped') {
                if (pendingUserSpeech) {
                  pendingUserSpeech = false;
                  try {
                    if (inGrace && !firstAutoCommitDone) {
                      scheduleCommitAfterGrace();
                    } else {
                      await localSession.commit();
                      firstAutoCommitDone = true;
                    }
                  } catch (err: any) {
                    callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_commit_failed', metadata });
                    void closeAll();
                    return;
                  }
                }
              } else if (event.type === 'assistant_audio.chunk') {
                const outputSpec = sessionReadyAudioOutput as AudioSpec;
                const outBytes = base64ToBytes(event.frame.dataBase64);
                const converted = convertAudioBytes({
                  input: outBytes,
                  inputSpec: outputSpec,
                  outputSpec: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
                });
                const framed = frameAudioBytes({
                  bytes: converted,
                  audio: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
                  frameMs
                });

                const maxPendingOutboundFrames = Math.max(0, Math.floor(limits.maxPendingOutboundAudioMs / frameMs));
                const wouldOverflow = outboundAudioQueue.size() + framed.length > maxPendingOutboundFrames;
                if (wouldOverflow) {
                  callbacks.onError?.({ message: 'Outbound backpressure', code: 'outbound_backpressure', metadata: call });
                  clearPlayback(call);
                  try {
                    await localSession.interrupt({ reason: 'outbound_backpressure' });
                  } catch (err: any) {
                    callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_interrupt_failed', metadata });
                    void closeAll();
                    return;
                  }
                } else {
                  for (const frame of framed) {
                    outboundAudioQueue.push({ kind: 'audio', bytes: frame });
                  }
                }
              } else if (event.type === 'assistant_audio.end') {
                const name = `d${++drainSeq}`;
                outboundAudioQueue.push({ kind: 'mark', name, markKind: 'drain' });
              } else if (event.type === 'playback.clear_requested') {
                clearPlayback(call);
              } else if (event.type === 'error' || event.type === 'timeout') {
                clearPlayback(call);
              } else if (event.type === 'closed') {
                void closeAll();
                return;
              }
            }
          } catch (err: any) {
            callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_pump_failed', metadata });
            void closeAll();
          }
        })();
      };

      ws.on('close', () => {
        void closeAll();
      });
      ws.on('error', () => {
        void closeAll();
      });

      touch();
      if (Number.isFinite(limits.maxSessionDurationMs) && limits.maxSessionDurationMs > 0) {
        durationTimer = setTimeout(() => {
          callbacks.onError?.({ message: 'WS max session duration exceeded', code: 'ws_max_duration', metadata });
          safeClose(ws, 1000, 'Max duration');
        }, limits.maxSessionDurationMs);
      }
      if (Number.isFinite(limits.startTimeoutMs) && limits.startTimeoutMs > 0) {
        startTimer = setTimeout(() => {
          callbacks.onError?.({ message: 'Missing start event', code: 'missing_start', metadata });
          safeClose(ws, 1008, 'Missing start');
        }, limits.startTimeoutMs);
      }

      const handleMedia = (msg: { streamSid: string; payloadBase64: string }) => {
        const bytesApprox = approxBytesFromBase64(msg.payloadBase64);
        rateLimiter.charge(bytesApprox);

        if (!sessionReadyAudioInput) {
          // Buffer until ready, up to a limit.
          const nextFrame: RealtimeAudioFrame = {
            format: 'g711_ulaw',
            sampleRateHz: 8000,
            channels: 1,
            dataBase64: msg.payloadBase64
          };
          inboundAudioQueue.push(nextFrame);
          return;
        }

        const inputBytes = base64ToBytes(msg.payloadBase64);
        const converted = convertAudioBytes({
          input: inputBytes,
          inputSpec: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
          outputSpec: sessionReadyAudioInput
        });
        const outBase64 = bytesToBase64(converted);
        inboundAudioQueue.push({
          format: sessionReadyAudioInput.format as any,
          sampleRateHz: sessionReadyAudioInput.sampleRateHz,
          channels: sessionReadyAudioInput.channels,
          dataBase64: outBase64
        });
      };

      ws.on('message', async (data: any) => {
        touch();
        const buf = Buffer.from(data as any);
        if (buf.length > limits.maxWsMessageBytes) {
          callbacks.onError?.({ message: 'WS message too large', code: 'message_too_large', metadata });
          safeClose(ws, 1009, 'Message too large');
          return;
        }

        const msgRaw = buf.toString('utf-8');

        let msg: any;
        try {
          msg = parseTwilioInboundMessage(msgRaw);
        } catch (err: any) {
          callbacks.onError?.({ message: String(err), code: 'invalid_twilio_message', metadata });
          safeClose(ws, 1003, 'Invalid message');
          return;
        }

        try {
          switch (msg.event) {
            case 'connected':
              return;
            case 'start': {
              if (metadata) return;
              if (startTimer) {
                clearTimeout(startTimer);
                startTimer = undefined;
              }

              metadata = extractMetadata({ streamSid: msg.streamSid, start: msg.start });
              if (allowedAccountSids.length > 0 && !allowedAccountSids.includes(metadata.accountSid)) {
                callbacks.onError?.({ message: 'Forbidden', code: 'account_sid_forbidden', metadata });
                safeClose(ws, 1008, 'Forbidden');
                return;
              }

              callbacks.onCallStart?.(metadata);
              session = await Promise.resolve(options.createSession({ metadata }));
              startSessionPump(session, metadata);
              return;
            }
            case 'media': {
              if (!metadata) {
                callbacks.onError?.({ message: 'Media received before start', code: 'media_before_start' });
                safeClose(ws, 1008, 'Missing start');
                return;
              }

              if (msg.streamSid !== metadata.streamSid) {
                callbacks.onError?.({ message: 'streamSid mismatch', code: 'stream_sid_mismatch', metadata });
                safeClose(ws, 1008, 'Forbidden');
                return;
              }

              if (inboundAudioQueue.size() >= limits.maxPendingInboundFrames) {
                callbacks.onError?.({ message: 'Inbound backpressure', code: 'inbound_backpressure', metadata });
                safeClose(ws, 1013, 'Busy');
                return;
              }

              handleMedia({ streamSid: msg.streamSid, payloadBase64: msg.payloadBase64 });
              return;
            }
            case 'mark': {
              if (!metadata) return;
              const msAt = markToMs.get(msg.name);
              const kind = markKindByName.get(msg.name);
              if (msAt !== undefined) {
                playedMs = msAt;
              }
              if (msAt !== undefined) markToMs.delete(msg.name);
              if (kind) markKindByName.delete(msg.name);
              callbacks.onMark?.({ name: msg.name, metadata, ...(kind ? { kind } : {}), playedMs });
              return;
            }
            case 'dtmf': {
              if (!metadata) return;
              callbacks.onDtmf?.({ digit: msg.digit, metadata });
              dtmfQueue.push(msg.digit);
              return;
            }
            case 'stop': {
              void closeAll();
              return;
            }
          }
        } catch (err: any) {
          callbacks.onError?.({ message: err?.message ?? String(err), code: err?.code ?? 'bridge_error', metadata });
          void closeAll();
        }
      });

      // Keep the promise alive until the socket closes.
      await new Promise<void>(resolve => {
        ws.on('close', () => resolve());
      });
    }
  };
}
