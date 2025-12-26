import type { JsonObject, JsonValue, RealtimeProviderManifest, UnifiedTool, ToolChoice } from './types.js';

// ============================================================
// REALTIME (provider-agnostic) types
// ============================================================

export type RealtimeAudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

export interface RealtimeAudioFrame {
  format: RealtimeAudioFormat;
  sampleRateHz: number;
  channels: 1 | 2;
  dataBase64: string;
  timestampMs?: number;
}

export interface RealtimeTurnDetectionConfig {
  mode: 'server_vad' | 'manual_commit';
}

export interface RealtimeBargeInConfig {
  enabled?: boolean;
  triggers?: Array<
    | 'user_speech.started'
    | 'user_transcript.delta'
    | 'user_dtmf.digit'
    | 'user_dtmf.sequence'
    | 'explicit_interrupt'
  >;
}

export interface RealtimeTimeoutConfig {
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  onTimeout?: 'close' | 'warn';
}

export interface RealtimeTranscriptionConfig {
  enabled?: boolean;
  language?: string;
}

export interface RealtimeDTMFConfig {
  /**
   * Controls whether DTMF is treated as individual digits or buffered into sequences.
   *
   * - `digit`: each digit is forwarded to the model immediately.
   * - `sequence`: digits are buffered until a terminator/max-length flush.
   */
  mode?: 'digit' | 'sequence';

  /**
   * Sequence mode: digits that trigger a flush (commonly `#` or `*`).
   * Defaults to `['#']`.
   */
  terminators?: string[];

  /**
   * Sequence mode: max buffered digit count before flushing.
   * Defaults to 32.
   */
  maxDigits?: number;
}

export interface RealtimeSessionAudioConfig {
  input?: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
  output?: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
}

export type RealtimeTransportType = 'ws' | 'webrtc';

export interface RealtimeTransportConfig {
  /**
   * Realtime connection transport.
   *
   * Defaults to `ws`.
   */
  type?: RealtimeTransportType;
}

export interface RealtimeWebrtcConfig {
  /**
   * Short-lived client credential used for WebRTC SDP exchange.
   *
   * This must NOT be a long-lived provider API key.
   */
  clientSecret?: string;

  /**
   * Optional input stream for WebRTC microphone capture (browser/mobile).
   *
   * This is intentionally typed as `unknown` to avoid requiring DOM libs in the core package.
   */
  inputStream?: unknown;

  /**
   * Optional callback invoked when a remote audio stream is available.
   *
   * This is intentionally typed as `unknown` to avoid requiring DOM libs in the core package.
   */
  onRemoteStream?: (stream: unknown) => void;

  /**
   * Optional data channel label override.
   *
   * Defaults to the provider's recommended label when omitted.
   */
  dataChannelLabel?: string;
}

export interface RealtimeHistoryItem {
  role: 'system' | 'user' | 'assistant';
  text: string;
}

export interface RealtimeToolCallTrackingConfig {
  /**
   * Max entries tracked for mapping provider tool call ids to tool names during a session.
   *
   * This is a per-session memory safety guard for long-lived sessions with heavy tool usage.
   *
   * Defaults to 1000.
   */
  maxEntries?: number;
}

export interface RealtimeEventBufferConfig {
  /**
   * Max normalized events to buffer when the consumer is not draining `session.events()`.
   *
   * When exceeded, the session fails fast with an `error` (code: `event_buffer_overflow`)
   * and closes to prevent unbounded memory growth.
   */
  maxEvents?: number;
}

export interface RealtimeSessionSpec {
  /** Provider id from plugins/realtime-providers/*.json */
  provider: string;
  model?: string;

  transport?: RealtimeTransportConfig;
  webrtc?: RealtimeWebrtcConfig;

  // prompt/context
  systemPrompt?: string;
  history?: RealtimeHistoryItem[];

  // tools
  functionToolNames?: string[];
  toolChoice?: ToolChoice;
  toolCallTracking?: RealtimeToolCallTrackingConfig;
  eventBuffer?: RealtimeEventBufferConfig;

  // audio + transcription
  audio?: RealtimeSessionAudioConfig;
  transcription?: RealtimeTranscriptionConfig;

  // turn detection + barge-in
  turnDetection?: RealtimeTurnDetectionConfig;
  bargeIn?: RealtimeBargeInConfig;

  // DTMF (touch tones)
  dtmf?: RealtimeDTMFConfig;

  // timeouts
  timeout?: RealtimeTimeoutConfig;

  metadata?: Record<string, any>;
}

export interface ReadyEvent {
  type: 'ready';
  sessionId: string;
  audio?: RealtimeSessionSpec['audio'];
  transcription?: RealtimeSessionSpec['transcription'];
}

export interface ClosedEvent {
  type: 'closed';
  reason?: 'client_close' | 'server_close' | 'provider_close' | 'error' | 'timeout';
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

export interface TimeoutEvent {
  type: 'timeout';
  reason: 'max_duration' | 'idle';
  elapsedMs: number;
  configuredMs: number;
}

export interface UserSpeechStartedEvent {
  type: 'user_speech.started';
}

export interface UserSpeechStoppedEvent {
  type: 'user_speech.stopped';
}

export interface UserTranscriptDeltaEvent {
  type: 'user_transcript.delta';
  textDelta: string;
}

export interface UserTranscriptFinalEvent {
  type: 'user_transcript.final';
  text: string;
}

export interface UserDTMFDigitEvent {
  type: 'user_dtmf.digit';
  digit: string;
}

export interface UserDTMFSequenceEvent {
  type: 'user_dtmf.sequence';
  digits: string;
  terminator?: string;
}

export interface AssistantTranscriptDeltaEvent {
  type: 'assistant_transcript.delta';
  textDelta: string;
}

export interface AssistantTranscriptFinalEvent {
  type: 'assistant_transcript.final';
  text: string;
}

export interface AssistantTextDeltaEvent {
  type: 'assistant_text.delta';
  textDelta: string;
}

export interface AssistantTextFinalEvent {
  type: 'assistant_text.final';
  text: string;
}

export interface AssistantAudioChunkEvent {
  type: 'assistant_audio.chunk';
  frame: RealtimeAudioFrame;
}

export interface AssistantAudioEndEvent {
  type: 'assistant_audio.end';
}

export interface ToolCallStartEvent {
  type: 'tool_call.start';
  toolCallId: string;
  name: string;
}

export interface ToolCallArgumentsDeltaEvent {
  type: 'tool_call.arguments_delta';
  toolCallId: string;
  jsonDelta: string;
}

export interface ToolCallEndEvent {
  type: 'tool_call.end';
  toolCallId: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolResultSentEvent {
  type: 'tool_result.sent';
  toolCallId: string;
}

export interface PlaybackMarkReceivedEvent {
  type: 'playback.mark_received';
  label: string;
}

export interface PlaybackClearRequestedEvent {
  type: 'playback.clear_requested';
  reason: 'barge_in' | 'interrupt' | 'timeout' | 'error';
  atMs?: number;
}

export interface UsageEvent {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  metadata?: JsonObject;
}

export type RealtimeEvent =
  | ReadyEvent
  | ClosedEvent
  | ErrorEvent
  | TimeoutEvent
  | UserSpeechStartedEvent
  | UserSpeechStoppedEvent
  | UserTranscriptDeltaEvent
  | UserTranscriptFinalEvent
  | UserDTMFDigitEvent
  | UserDTMFSequenceEvent
  | AssistantTranscriptDeltaEvent
  | AssistantTranscriptFinalEvent
  | AssistantTextDeltaEvent
  | AssistantTextFinalEvent
  | AssistantAudioChunkEvent
  | AssistantAudioEndEvent
  | ToolCallStartEvent
  | ToolCallArgumentsDeltaEvent
  | ToolCallEndEvent
  | ToolResultSentEvent
  | PlaybackMarkReceivedEvent
  | PlaybackClearRequestedEvent
  | UsageEvent;

// ============================================================
// Realtime compat interface (implemented by plugins)
// ============================================================

export interface RealtimeCompatSession {
  sendText: (options: { text: string; role?: 'system' | 'user' }) => Promise<void> | void;
  injectContext: (items: RealtimeHistoryItem[]) => Promise<void> | void;
  sendAudio: (frame: RealtimeAudioFrame) => Promise<void> | void;
  commit: () => Promise<void> | void;
  interrupt: (options?: { reason?: string }) => Promise<void> | void;
  sendToolResult: (options: { toolCallId: string; result: JsonValue }) => Promise<void> | void;
  events: () => AsyncIterable<RealtimeEvent>;
  close: () => Promise<void> | void;
}

export interface RealtimeClientSecret {
  clientSecret: string;
  /**
   * Expiration timestamp (unix seconds) when provided by the provider.
   */
  expiresAt?: number;
}

export interface IRealtimeCompat {
  createSession: (options: {
    provider: RealtimeProviderManifest;
    spec: RealtimeSessionSpec;
    tools?: UnifiedTool[];
  }) => Promise<RealtimeCompatSession> | RealtimeCompatSession;

  /**
   * Optional capability to mint short-lived client credentials for browser/mobile usage.
   * Intended for WebRTC session establishment where long-lived provider keys must not be exposed client-side.
   */
  mintClientSecret?: (options: {
    provider: RealtimeProviderManifest;
    spec: RealtimeSessionSpec;
    expiresAfterSeconds?: number;
  }) => Promise<RealtimeClientSecret> | RealtimeClientSecret;
}
