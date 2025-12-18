# `plugins/realtime-compat/gemini`

Realtime compat for the Gemini Live API.

This module implements the provider-agnostic realtime session interface (`IRealtimeCompat`) using the Gemini Live WebSocket protocol.

## Provider manifest

Add a `realtime` block to the provider manifest (for example `plugins/providers/google.json`) with:

- `realtime.compat`: `gemini`
- `realtime.endpoint.urlTemplate`: Live WebSocket endpoint
- `realtime.endpoint.headers` / `realtime.endpoint.query`: authentication

Example:

```json
{
  "realtime": {
    "compat": "gemini",
    "endpoint": {
      "urlTemplate": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService/BidiGenerateContent",
      "headers": {},
      "query": { "key": "${GEMINI_API_KEY}" }
    }
  }
}
```

## Environment variables

- `GEMINI_API_KEY` (required) — used by the provider manifest for both standard calls and realtime sessions.

## Session spec

### Model naming

- `spec.model` is required unless the provider manifest supplies `provider.realtime.metadata.defaultModel`.
- The setup message normalizes model names to `models/...` (if `spec.model` does not already start with `models/`).

## Audio

- Session input audio is converted to provider-required **PCM16 mono @ 16kHz**.
- Provider output audio is converted to the configured session output format before emitting `assistant_audio.chunk`.

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
- `interrupt()` sends an empty `clientContent` message which interrupts any current model generation.

## Tool calling

Tool calls are mapped from provider function-call messages to:

- `tool_call.start`
- `tool_call.end`

Tool results are sent back via the provider tool-response message.

If a tool result is not a JSON object (for example a string/number), it is wrapped as `{ "output": <value> }`.
