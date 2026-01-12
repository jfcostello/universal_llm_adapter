import type { RealtimeAudioFrame, RealtimeEvent } from '../../../../../kernel/index.js';
import type { RealtimeSession } from '../../../../../modules/realtime/index.js';
import { AudioPacer, base64ToBytes, bytesToBase64, durationMsForBytes } from '../../../../../modules/audio/index.js';
import { setUnrefTimeout } from '../../../../../modules/shared/index.js';
import { createAudioRateLimiter } from '../../../../../modules/server/index.js';

import type { AudioSpec } from './audio.js';
import { convertAudioBytes, frameAudioBytes } from './audio.js';
import { ResettableQueue } from './resettable-queue.js';

export type VoiceRequestLike = { url?: string | undefined };

export type VoiceMediaWsLike = {
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: 'message' | 'close' | 'error', cb: (...args: any[]) => void) => void;
};

export type VoiceMediaOutboundMessage = string | Record<string, any>;

export type VoiceMediaAudioConfig = {
  input: AudioSpec;
  output: AudioSpec;
};

export type VoiceMediaInboundEvent<Metadata> =
  | { type: 'connected' }
  | { type: 'start'; streamId: string; metadata: Metadata }
  | { type: 'media'; streamId: string; payloadBase64: string }
  | { type: 'mark'; streamId: string; name: string }
  | { type: 'dtmf'; streamId: string; digit: string }
  | { type: 'stop'; streamId: string };

export interface VoiceMediaProtocolAdapter<Metadata> {
  parseInbound: (raw: string) => VoiceMediaInboundEvent<Metadata>;
  buildClearMessage: (options: { streamId: string }) => VoiceMediaOutboundMessage;
  buildMarkMessage: (options: { streamId: string; name: string }) => VoiceMediaOutboundMessage;
  buildAudioMessage: (options: { streamId: string; payloadBase64: string }) => VoiceMediaOutboundMessage;
}

export interface VoiceMediaWsBridgeLimits {
  maxWsMessageBytes?: number;
  maxAudioBytesPerSecond?: number;
  idleTimeoutMs?: number;
  maxSessionDurationMs?: number;
  startTimeoutMs?: number;
  maxPendingInboundFrames?: number;
  maxPendingOutboundFrames?: number;
  firstTurnGraceMs?: number;
}

export interface VoiceMediaWsBridgeAudioOptions {
  frameMs?: number;
  markEveryMs?: number;
  pacing?: {
    enabled?: boolean;
    pacer?: Pick<AudioPacer, 'paceBytes' | 'reset'>;
  };
}

export interface VoiceMediaWsBridgeCallbacks<Metadata> {
  onCallStart?: (metadata: Metadata) => void;
  onDtmf?: (options: { digit: string; metadata: Metadata }) => void;
  onMark?: (options: { name: string; metadata: Metadata; kind?: 'periodic' | 'drain'; playedMs?: number }) => void;
  onRealtimeEvent?: (options: { event: RealtimeEvent; metadata: Metadata }) => void;
  onError?: (options: { message: string; code?: string; metadata?: Metadata }) => void;
}

export interface VoiceMediaWsBridgeOptions<Metadata> {
  createSession: (options: { metadata: Metadata }) => Promise<RealtimeSession> | RealtimeSession;
  adapter: VoiceMediaProtocolAdapter<Metadata>;
  mediaAudio: VoiceMediaAudioConfig;
  limits?: VoiceMediaWsBridgeLimits;
  audio?: VoiceMediaWsBridgeAudioOptions;
  callbacks?: VoiceMediaWsBridgeCallbacks<Metadata>;
}

export interface VoiceMediaWsBridge {
  handleConnection: (ws: VoiceMediaWsLike, req: VoiceRequestLike) => Promise<void>;
}

const DEFAULT_LIMITS: Required<VoiceMediaWsBridgeLimits> = {
  maxWsMessageBytes: 262144,
  maxAudioBytesPerSecond: 256000,
  idleTimeoutMs: 60000,
  maxSessionDurationMs: 3600000,
  startTimeoutMs: 5000,
  maxPendingInboundFrames: 200,
  maxPendingOutboundFrames: 15000,
  firstTurnGraceMs: 0
};

const DEFAULT_AUDIO: Required<Pick<VoiceMediaWsBridgeAudioOptions, 'frameMs' | 'markEveryMs'>> = {
  frameMs: 20,
  markEveryMs: 200
};

function approxBytesFromBase64(base64: string): number {
  const len = Math.max(0, base64.length);
  return Math.floor((len * 3) / 4);
}

function ensureSendable(ws: VoiceMediaWsLike): void {
  const state = ws.readyState;
  // WebSocket.OPEN is 1 in `ws`, but we avoid depending on the library.
  if (state !== undefined && state !== 1) {
    throw new Error('WebSocket not open');
  }
}

function safeClose(ws: VoiceMediaWsLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {}
}

async function* iterateAsyncIterator<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

type OutboundItem =
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'mark'; name: string; markKind: 'periodic' | 'drain' };

export function createVoiceMediaWsBridge<Metadata>(options: VoiceMediaWsBridgeOptions<Metadata>): VoiceMediaWsBridge {
  const limits: Required<VoiceMediaWsBridgeLimits> = {
    ...DEFAULT_LIMITS,
    ...(options.limits ?? {})
  };
  const audioCfg = options.audio ?? {};
  const frameMs = Math.max(1, Math.floor(audioCfg.frameMs ?? DEFAULT_AUDIO.frameMs));
  const markEveryMs = Math.max(1, Math.floor(audioCfg.markEveryMs ?? DEFAULT_AUDIO.markEveryMs));
  const pacer = audioCfg.pacing?.pacer ?? new AudioPacer();
  const pacingEnabled = audioCfg.pacing?.enabled !== false;

  const adapter = options.adapter;

  const mediaInputAudio: AudioSpec = {
    format: options.mediaAudio.input.format,
    sampleRateHz: Number(options.mediaAudio.input.sampleRateHz),
    channels: options.mediaAudio.input.channels as 1 | 2
  };
  const mediaOutputAudio: AudioSpec = {
    format: options.mediaAudio.output.format,
    sampleRateHz: Number(options.mediaAudio.output.sampleRateHz),
    channels: options.mediaAudio.output.channels as 1 | 2
  };

  const callbacks = options.callbacks ?? {};

  return {
    async handleConnection(ws: VoiceMediaWsLike, _req: VoiceRequestLike): Promise<void> {
      const rateLimiter = createAudioRateLimiter(limits.maxAudioBytesPerSecond);

      let idleTimer: any | undefined;
      let durationTimer: any | undefined;
      let startTimer: any | undefined;
      let firstTurnGraceTimer: any | undefined;

      let closed = false;
      let metadata: Metadata | undefined;
      let streamId: string | undefined;

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

      const touch = () => {
        if (!Number.isFinite(limits.idleTimeoutMs) || limits.idleTimeoutMs <= 0) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setUnrefTimeout(() => {
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

      const sendMessage = (msg: VoiceMediaOutboundMessage) => {
        if (closed) return;
        try {
          ensureSendable(ws);
          touch();
          ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        } catch (err: any) {
          callbacks.onError?.({ message: err?.message ?? String(err), code: 'ws_send_failed', metadata });
          void closeAll();
        }
      };

      const clearPlayback = (call: Metadata, callStreamId: string) => {
        outboundAudioQueue.clear();
        pacer.reset();

        sentAudioMsTotal = 0;
        pendingMarkMs = 0;
        markSeq = 0;
        drainSeq = 0;
        playedMs = undefined;
        markToMs.clear();
        markKindByName.clear();

        sendMessage(adapter.buildClearMessage({ streamId: callStreamId }));
      };

      const startOutboundPump = (call: Metadata, callStreamId: string) => {
        void (async () => {
          while (true) {
            const next = await outboundAudioQueue.next();
            if (!next) return;

            const { value, generation } = next;

            if (value === null) {
              continue;
            }

            if (generation !== outboundAudioQueue.currentGeneration()) {
              continue;
            }

            if (value.kind === 'mark') {
              markToMs.set(value.name, sentAudioMsTotal);
              markKindByName.set(value.name, value.markKind);
              sendMessage(adapter.buildMarkMessage({ streamId: callStreamId, name: value.name }));
              continue;
            }

            const bytes = value.bytes;

            // Any clear interrupts in-flight frames as well as queued frames.
            if (pacingEnabled) {
              await pacer.paceBytes({
                format: mediaOutputAudio.format,
                sampleRateHz: mediaOutputAudio.sampleRateHz,
                channels: mediaOutputAudio.channels,
                byteLength: bytes.length
              });
            }

            if (generation !== outboundAudioQueue.currentGeneration()) {
              continue;
            }

            const payloadBase64 = bytesToBase64(bytes);
            sendMessage(adapter.buildAudioMessage({ streamId: callStreamId, payloadBase64 }));

            // Mark tracking for playback progress.
            const durMs = durationMsForBytes({
              format: mediaOutputAudio.format,
              sampleRateHz: mediaOutputAudio.sampleRateHz,
              channels: mediaOutputAudio.channels,
              byteLength: bytes.length
            });
            sentAudioMsTotal += durMs;
            pendingMarkMs += durMs;
            if (pendingMarkMs >= markEveryMs) {
              const name = `m${++markSeq}`;
              markToMs.set(name, sentAudioMsTotal);
              markKindByName.set(name, 'periodic');
              pendingMarkMs = 0;
              sendMessage(adapter.buildMarkMessage({ streamId: callStreamId, name }));
            }
          }
        })();
      };

      const startInboundPump = (localSession: RealtimeSession) => {
        void (async () => {
          while (true) {
            const frame = await inboundAudioQueue.nextValue();
            if (frame === null) return;
            try {
              const target = sessionReadyAudioInput;
              if (target) {
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

              await localSession.sendAudio(frame);
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
            const digit = await dtmfQueue.nextValue();
            if (digit === null) return;
            try {
              await localSession.sendDTMF(digit);
            } catch (err: any) {
              callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_send_dtmf_failed', metadata });
              void closeAll();
              return;
            }
          }
        })();
      };

      const startSessionPump = (localSession: RealtimeSession, call: Metadata, callStreamId: string) => {
        void (async () => {
          try {
            const iterator = localSession.events()[Symbol.asyncIterator]();

            const first = await iterator.next();
            if (first.done || !first.value) {
              callbacks.onError?.({ message: 'Session ended before ready', code: 'session_ended_before_ready', metadata: call });
              void closeAll();
              return;
            }
            if (first.value.type !== 'ready') {
              callbacks.onError?.({ message: 'Expected ready event', code: 'unexpected_session_event', metadata: call });
              void closeAll();
              return;
            }

            const audio = (first.value as any)?.audio ?? {};
            const inCfg = audio?.input ?? {};
            const outCfg = audio?.output ?? {};

            sessionReadyAudioInput = {
              format: (inCfg.format ?? mediaInputAudio.format) as AudioSpec['format'],
              sampleRateHz: Number(inCfg.sampleRateHz ?? mediaInputAudio.sampleRateHz),
              channels: (inCfg.channels ?? mediaInputAudio.channels) as 1 | 2
            };
            sessionReadyAudioOutput = {
              format: (outCfg.format ?? mediaOutputAudio.format) as AudioSpec['format'],
              sampleRateHz: Number(outCfg.sampleRateHz ?? mediaOutputAudio.sampleRateHz),
              channels: (outCfg.channels ?? mediaOutputAudio.channels) as 1 | 2
            };

            // Start pumps once the session is ready.
            startInboundPump(localSession);
            startOutboundPump(call, callStreamId);
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
              firstTurnGraceTimer = setUnrefTimeout(() => {
                firstTurnGraceTimer = undefined;
                void (async () => {
                  try {
                    await localSession.commit();
                    firstAutoCommitDone = true;
                  } catch (err: any) {
                    callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_commit_failed', metadata: call });
                    void closeAll();
                  }
                })();
              }, delay);
            };

            for await (const event of iterateAsyncIterator(iterator)) {
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
                    callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_commit_failed', metadata: call });
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
                  outputSpec: mediaOutputAudio
                });
                const framed = frameAudioBytes({
                  bytes: converted,
                  audio: mediaOutputAudio,
                  frameMs
                });

                const maxPendingOutboundFramesRaw = Number(limits.maxPendingOutboundFrames);
                const maxPendingOutboundFrames = Number.isFinite(maxPendingOutboundFramesRaw)
                  ? Math.max(1, Math.floor(maxPendingOutboundFramesRaw))
                  : DEFAULT_LIMITS.maxPendingOutboundFrames;
                const wouldOverflow = outboundAudioQueue.size() + framed.length > maxPendingOutboundFrames;
                if (wouldOverflow) {
                  callbacks.onError?.({ message: 'Outbound backpressure', code: 'outbound_backpressure', metadata: call });
                  clearPlayback(call, callStreamId);

                  const capped = framed.length > maxPendingOutboundFrames
                    ? framed.slice(framed.length - maxPendingOutboundFrames)
                    : framed;
                  for (const frame of capped) {
                    outboundAudioQueue.push({ kind: 'audio', bytes: frame });
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
                clearPlayback(call, callStreamId);
              } else if (event.type === 'error' || event.type === 'timeout') {
                clearPlayback(call, callStreamId);
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
        durationTimer = setUnrefTimeout(() => {
          callbacks.onError?.({ message: 'WS max session duration exceeded', code: 'ws_max_duration', metadata });
          safeClose(ws, 1000, 'Max duration');
        }, limits.maxSessionDurationMs);
      }
      if (Number.isFinite(limits.startTimeoutMs) && limits.startTimeoutMs > 0) {
        startTimer = setUnrefTimeout(() => {
          callbacks.onError?.({ message: 'Missing start event', code: 'missing_start', metadata });
          safeClose(ws, 1008, 'Missing start');
        }, limits.startTimeoutMs);
      }

      const handleMedia = (msg: { payloadBase64: string }) => {
        const bytesApprox = approxBytesFromBase64(msg.payloadBase64);
        rateLimiter.charge(bytesApprox);

        // Always enqueue frames as the configured `mediaAudio.input`; the inbound pump will convert
        // to the negotiated session audio.input spec only when needed.
        inboundAudioQueue.push({
          format: mediaInputAudio.format,
          sampleRateHz: mediaInputAudio.sampleRateHz,
          channels: mediaInputAudio.channels,
          dataBase64: msg.payloadBase64
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

        let msg: VoiceMediaInboundEvent<Metadata>;
        try {
          msg = adapter.parseInbound(msgRaw);
        } catch (err: any) {
          callbacks.onError?.({ message: String(err), code: 'invalid_message', metadata });
          safeClose(ws, 1003, 'Invalid message');
          return;
        }

        try {
          switch (msg.type) {
            case 'connected':
              return;
            case 'start': {
            if (metadata) return;
              if (startTimer) {
                clearTimeout(startTimer);
                startTimer = undefined;
              }

              metadata = msg.metadata;
              const callStreamId = msg.streamId;
              streamId = callStreamId;

              callbacks.onCallStart?.(metadata);
              session = await Promise.resolve(options.createSession({ metadata }));
              startSessionPump(session, metadata, callStreamId);
              return;
            }
            case 'media': {
              if (!metadata || !streamId) {
                callbacks.onError?.({ message: 'Media received before start', code: 'media_before_start' });
                safeClose(ws, 1008, 'Missing start');
                return;
              }

              if (msg.streamId !== streamId) {
                callbacks.onError?.({ message: 'streamId mismatch', code: 'stream_id_mismatch', metadata });
                safeClose(ws, 1008, 'Forbidden');
                return;
              }

              if (inboundAudioQueue.size() >= limits.maxPendingInboundFrames) {
                callbacks.onError?.({ message: 'Inbound backpressure', code: 'inbound_backpressure', metadata });
                safeClose(ws, 1013, 'Busy');
                return;
              }

              handleMedia({ payloadBase64: msg.payloadBase64 });
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
