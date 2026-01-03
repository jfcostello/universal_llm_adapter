# `plugins/realtime-compat/gemini`

Realtime compat for the Gemini Live API.

This module implements the provider-agnostic realtime session interface (`IRealtimeCompat`) using the Gemini Live WebSocket protocol.

## Provider manifest

Create a realtime provider manifest (for example `plugins/realtime-providers/google.json`) with:

- `compat`: `gemini`
- `endpoint.urlTemplate`: Live WebSocket endpoint
- `endpoint.headers` / `endpoint.query`: authentication

Example:

```json
{
  "id": "google",
  "compat": "gemini",
  "endpoint": {
    "urlTemplate": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    "headers": {},
    "query": { "key": "${GEMINI_API_KEY}" }
  }
}
```

## Environment variables

- `GEMINI_API_KEY` (required) — used by the provider manifest for both standard calls and realtime sessions.

## Session spec

### Model naming

- `spec.model` is required unless the realtime provider manifest supplies `metadata.defaultModel`.
- The setup message normalizes model names to `models/...` (if `spec.model` does not already start with `models/`).

## Audio

- Session input audio is converted to provider-required **PCM16 mono @ 16kHz**.
- Provider output audio (typically **PCM16 mono @ 24kHz**) is converted to the configured session output format before emitting `assistant_audio.chunk` (the sample rate is parsed from `audio/pcm;rate=...` when present).

Constraints:

- Mono only (`channels=1`).
- Supported session input formats: `pcm16`, `g711_ulaw`.
- Supported session output formats: `pcm16`, `g711_ulaw`.
- `g711_alaw` is not supported yet.

## Transcription

When `spec.transcription.enabled` is true, both input and output audio transcriptions are enabled and mapped to normalized transcript events.

## History injection

This compat supports **startup-only** text history seeding:

- Provide `spec.history` when creating the session.
- The compat renders history into the initial setup `systemInstruction` text as a summary.

Runtime `session.injectContext(items)` is **not supported** and will throw.

## Turn detection and interruption

- `turnDetection.mode=manual_commit`:
  - disables automatic activity detection
  - sends `activityStart` on the first audio frame after a commit boundary
  - sends `activityEnd` on `commit()`
  - emits `user_speech.started` / `user_speech.stopped` locally for faster barge-in flows
- `turnDetection.mode=server_vad`:
  - leaves provider automatic activity detection enabled
  - emits `user_speech.started` locally on the first audio frame in a detected user turn
  - emits `user_speech.stopped` when the server reports turn completion
  - emits `user_transcript.final` at turn completion when transcription is enabled
- `interrupt()` sends an empty `clientContent` message which interrupts any current model generation.

## Extended session settings

Pass extended settings via `spec.settings`. All settings support both camelCase and snake_case aliases.

| Setting | Type | Description |
|---------|------|-------------|
| `temperature` | number | Sampling temperature |
| `maxOutputTokens` | int | Max output tokens (aliases: `maxTokens`, `max_output_tokens`) |
| `voice` | string | Voice name for audio output (e.g., `"Kore"`, `"Aoede"`) |
| `topP` | number | Nucleus sampling probability |
| `topK` | int | Top-K sampling parameter |
| `enableAffectiveDialog` | boolean | Enable affective dialog (adapts response style to input tone) |
| `proactiveAudio` | boolean | Enable proactive audio responses |
| `startOfSpeechSensitivity` | string | Speech start detection sensitivity (e.g., `"START_SENSITIVITY_LOW"`) |
| `endOfSpeechSensitivity` | string | Speech end detection sensitivity (e.g., `"END_SENSITIVITY_HIGH"`) |
| `vadPrefixPaddingMs` | int | Audio padding before speech detection |
| `vadSilenceDurationMs` | int | Silence duration to end turn |

Note: `int` values are parsed as **positive integers (>0)**.

Note: Thinking settings are **not supported** for Live sessions. If provided, they will be ignored and surfaced as `unsupported_session_settings`.

Example:
```ts
const session = await createRealtimeSession(registry, {
  provider: 'google',
  model: 'gemini-2.0-flash-exp',
  turnDetection: { mode: 'server_vad' },
  settings: {
    voice: 'Kore',
    temperature: 0.7,
    top_p: 0.95,
    enable_affective_dialog: true,
    proactive_audio: true,
    start_of_speech_sensitivity: 'START_SENSITIVITY_LOW',
    vad_silence_duration_ms: 300
  }
});
```

## Tool calling

Tool calls are mapped from provider function-call messages to:

- `tool_call.start`
- `tool_call.end`

Tool results are sent back via the provider tool-response message.

If a tool result is not a JSON object (for example a string/number), it is wrapped as `{ "output": <value> }`.
