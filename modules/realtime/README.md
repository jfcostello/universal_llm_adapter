# `modules/realtime`

Provider-agnostic realtime session coordinator.

## Public API

### Create a session

```ts
import { PluginRegistry } from 'llm-adapter';
import { createRealtimeSession } from 'llm-adapter/realtime';

const registry = new PluginRegistry('./plugins');
const session = await createRealtimeSession(registry, {
  provider: '...',
  model: '...',
  systemPrompt: '...',
  transcription: { enabled: true },
  turnDetection: { mode: 'manual_commit' },
  audio: {
    input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
    output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
  }
});
```

`createRealtimeSession(registry, spec)` is **async** and returns a `RealtimeSession`.

### `RealtimeSession`

- `events(): AsyncIterable<RealtimeEvent>`
  - Single-consumer: `events()` can only be called once per session instance.
  - Ordering: the first emitted event is always `ready` (or the session closes with an `error` + `closed`).
- `sendText({ text, role? })`
- `injectContext(items: RealtimeHistoryItem[])`
- `sendDTMF(digit: string)`
- `sendAudio(frame: RealtimeAudioFrame)`
- `commit()`
- `interrupt({ reason? })`
- `close()`

Types are re-exported from this module for convenience:
- `RealtimeSessionSpec`
- `RealtimeHistoryItem`
- `RealtimeAudioFrame`
- `RealtimeEvent`

---

## Architecture

- Core is provider-agnostic and loads the provider-specific realtime compat lazily via `registry.getRealtimeCompat(kind)`.
- Provider-specific realtime implementations live under `plugins/realtime-compat/*`.
- Tool execution is lazy-loaded and only activated when tools are enabled via `spec.functionToolNames`.

---

## `RealtimeSessionSpec` (overview)

The spec is intentionally provider-agnostic. Not all providers emit all events; behavior depends on provider capabilities and which features you enable.

Key fields:

- `provider` / `model`: realtime provider id from `plugins/realtime-providers/*.json` and a provider-specific model string.
- `transport`: transport selection (default `ws`). `type: 'webrtc'` enables WebRTC when supported by the selected provider compat.
- `webrtc`: WebRTC-only options:
  - `clientSecret`: short-lived client credential used for SDP exchange (required for `transport.type: 'webrtc'`).
  - `inputStream`: optional local media stream to attach as microphone input before offer creation.
  - `onRemoteStream`: callback invoked with the remote media stream for playback.
  - `dataChannelLabel`: override the data-channel label used for JSON events.
- `systemPrompt`: optional system prompt for the session.
- `history`: optional **text-first** conversation seeding (cross-session context) injected before the first user-visible `ready` event is emitted.
  - Each item is `{ role: 'system' | 'user' | 'assistant', text: string }`.
  - Use `session.injectContext(items)` for mid-session injection (does not auto-trigger a response).
- `functionToolNames` / `toolChoice`: enable tool calling within the session.
- `toolCallTracking`: bounds internal tool-call id → name tracking (default `maxEntries: 1000`).
- `audio`: negotiated session audio input/output formats.
- `transcription`: enable user transcription (and optionally language hints).
- `turnDetection`: `manual_commit` vs `server_vad`.
- `bargeIn`: interruption (barge-in) configuration.
- `dtmf`: touch-tone input behavior (digit vs sequence buffering).
- `timeout`: max duration + idle timeout behavior.

---

## DTMF (touch tones)

DTMF is treated as transport-agnostic user input. Calling `session.sendDTMF(digit)` injects a model-visible user turn as text:

- `mode: 'digit'` (default): sends `DTMF: <digit>` and commits immediately.
- `mode: 'sequence'`: buffers digits until a terminator/max-length flush, then sends `DTMF sequence: <digits>` and commits.

Configure via `spec.dtmf`:

```ts
dtmf: {
  mode: 'digit', // or 'sequence'
  terminators: ['#'], // sequence mode only
  maxDigits: 32 // sequence mode only
}
```

DTMF can also be used as a barge-in trigger via `spec.bargeIn.triggers`.

---

## Normalized `RealtimeEvent` taxonomy

These events are the stable contract that:
- provider compats must emit
- CLI/server transports must serialize (JSON envelopes)
- downstream bridges (telephony, etc.) must consume

### Lifecycle

- `ready`
  - `{ type: 'ready', sessionId, audio?, transcription? }`
- `closed`
  - `{ type: 'closed', reason?: 'client_close' | 'server_close' | 'provider_close' | 'error' | 'timeout' }`
- `error`
  - `{ type: 'error', message, code? }`
- `timeout`
  - `{ type: 'timeout', reason: 'max_duration' | 'idle', elapsedMs, configuredMs }`

### User speech + transcript

- `user_speech.started`
  - `{ type: 'user_speech.started' }`
- `user_speech.stopped`
  - `{ type: 'user_speech.stopped' }`
- `user_transcript.delta`
  - `{ type: 'user_transcript.delta', textDelta }`
- `user_transcript.final`
  - `{ type: 'user_transcript.final', text }`

### DTMF (touch tones)

- `user_dtmf.digit`
  - `{ type: 'user_dtmf.digit', digit }`
- `user_dtmf.sequence`
  - `{ type: 'user_dtmf.sequence', digits, terminator? }`

### Assistant transcript + audio

- `assistant_transcript.delta`
  - `{ type: 'assistant_transcript.delta', textDelta }`
- `assistant_transcript.final`
  - `{ type: 'assistant_transcript.final', text }`
- `assistant_audio.chunk`
  - `{ type: 'assistant_audio.chunk', frame: RealtimeAudioFrame }`
- `assistant_audio.end`
  - `{ type: 'assistant_audio.end' }`

Note: in WebRTC mode, remote audio may be delivered as a media track/stream via `spec.webrtc.onRemoteStream` instead of normalized `assistant_audio.chunk` events.

Optional (provider-dependent):

- `assistant_text.delta` / `assistant_text.final`

### Tool calling

- `tool_call.start`
  - `{ type: 'tool_call.start', toolCallId, name }`
- `tool_call.arguments_delta`
  - `{ type: 'tool_call.arguments_delta', toolCallId, jsonDelta }`
- `tool_call.end`
  - `{ type: 'tool_call.end', toolCallId, name, arguments }`
- `tool_result.sent`
  - `{ type: 'tool_result.sent', toolCallId }`

### Playback control (transport-facing)

- `playback.clear_requested`
  - `{ type: 'playback.clear_requested', reason: 'barge_in' | 'interrupt' | 'timeout' | 'error', atMs? }`

This is the normalized “stop audible output now” primitive. Downstream transports should treat it as authoritative and immediately stop playback (e.g., clear buffered audio).

### Usage

- `usage`
  - `{ type: 'usage', inputTokens?, outputTokens?, metadata? }`

---

## Barge-in semantics

Barge-in is enabled via:

```ts
bargeIn: {
  enabled: true,
  triggers: ['user_speech.started', 'user_dtmf.digit'] // default
}
```

When a configured trigger occurs while the assistant is outputting, the session controller will:

1. Ask the provider compat to interrupt/cancel output (`compatSession.interrupt({ reason: 'barge_in' })`)
2. Emit `{ type: 'playback.clear_requested', reason: 'barge_in' }`

Separately, when you call `session.interrupt()` explicitly, the controller emits:

- `{ type: 'playback.clear_requested', reason: 'interrupt' }`

Downstream transports should listen for `playback.clear_requested` and immediately stop playback / drop queued audio.

---

## Tool calling in realtime sessions

Enable tools by listing them in `functionToolNames` (tool definitions come from `plugins/tools/*.json`):

```ts
functionToolNames: ['test.echo'],
toolChoice: 'auto'
```

Flow:

1. Provider emits normalized tool call events (`tool_call.*`)
2. Core lazily loads the tool runner and executes via process routes (`plugins/processes/*.json`)
3. Core sends the tool result back to the compat session (`compatSession.sendToolResult(...)`)
4. Core emits `tool_result.sent` and generation continues

If tools are disabled but a tool call is received, the session emits an `error` and closes.

---

## Timeouts (MVP)

Timeouts are enforced per-session via `spec.timeout`:

- `maxDurationMs` (default: 10 minutes)
- `idleTimeoutMs` (default: 60 seconds)
- `onTimeout` (`close` or `warn`, default: `close`)

When a timeout triggers, the session emits:

1. a `timeout` event
2. a `playback.clear_requested` event (`reason: 'timeout'`)

If `onTimeout: 'close'`, the session then closes.

---

## Transport parity (CLI/server)

The realtime API is designed to work identically across transports:

- CLI: `llm-adapter realtime` (stdin/stdout JSON protocol)
- Server: `/realtime/ws` (WebSocket JSON protocol)

Both transports emit the same normalized `RealtimeEvent`s (wrapped in simple JSON envelopes).

### Realtime wire protocol (v1)

Client → transport (stdin/stdout or WS JSON messages):

```json
{ "type": "open", "protocolVersion": 1, "spec": { /* RealtimeSessionSpec */ } }
{ "type": "send_text", "text": "hello", "role": "user" }
{ "type": "inject_context", "items": [ { "role": "system", "text": "Remember TOKEN_123" } ] }
{ "type": "send_audio", "frame": { "format": "pcm16", "sampleRateHz": 24000, "channels": 1, "dataBase64": "..." } }
{ "type": "commit" }
{ "type": "interrupt", "reason": "barge_in" }
{ "type": "close" }
```

Transport → client:

```json
{ "type": "event", "event": { /* RealtimeEvent */ } }
{ "type": "error", "error": { "message": "…", "code": "…" } }
```

---

## Security posture

Realtime sessions are long-lived and can carry high-bandwidth audio. Follow these guidelines:

- Prefer the in-process CLI transport for local runs.
- If you enable the server WebSocket endpoint, require authentication and configure conservative limits (message size, audio throughput, idle timeout, max sessions).
- Do not log raw audio payloads (`dataBase64`) or credentials/tokens. If you log events, redact audio frames.

---

## Examples

- `examples/realtime-basic/` — minimal provider-agnostic realtime session example (text + optional audio + tools).
