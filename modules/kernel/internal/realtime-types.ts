import type { JsonObject, JsonValue, ProviderManifest, UnifiedTool, ToolChoice } from './types.js';

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

export interface RealtimeSessionSpec {
  /** Provider id from plugins/providers/*.json */
  provider: string;
  model?: string;

  // prompt/context
  systemPrompt?: string;

  // tools
  functionToolNames?: string[];
  toolChoice?: ToolChoice;

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
  sendAudio: (frame: RealtimeAudioFrame) => Promise<void> | void;
  commit: () => Promise<void> | void;
  interrupt: (options?: { reason?: string }) => Promise<void> | void;
  sendToolResult: (options: { toolCallId: string; result: JsonValue }) => Promise<void> | void;
  events: () => AsyncIterable<RealtimeEvent>;
  close: () => Promise<void> | void;
}

export interface IRealtimeCompat {
  createSession: (options: {
    provider: ProviderManifest;
    spec: RealtimeSessionSpec;
    tools?: UnifiedTool[];
  }) => Promise<RealtimeCompatSession> | RealtimeCompatSession;
}
