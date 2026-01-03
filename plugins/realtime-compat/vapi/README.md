# `plugins/realtime-compat/vapi`

Vapi realtime compat (WebSocket transport).

## Configuration

Required env vars:
- `VAPI_API_KEY`

Provider manifest:
- `plugins/realtime-providers/vapi.json`

## Notes

- This compat creates calls via `POST https://api.vapi.ai/call` with `transport.provider: "vapi.websocket"` and then connects to the returned `transport.websocketCallUrl`.
- Audio is sent/received as binary frames over the WS.
- When `transcription.enabled` is set, the compat enables transcript artifacts and configures a transcriber so `user_transcript.*` events are available.
  - Defaults come from provider metadata in `plugins/realtime-providers/vapi.json`.
  - Override per-session via `spec.transcription.provider` / `spec.transcription.model` (and/or `spec.settings.transcriberProvider` / `spec.settings.transcriberModel`).
- Tool calling: Vapi’s primary supported tool-result loop is server-webhook based. This compat implements a best-effort local tool loop by injecting tool output back into the call context.
- Tool result fallback: if no assistant activity is observed shortly after sending tool results, the compat may issue a `say` control message with the tool result content to prevent deadlocks in voice-first flows.

## Session settings

This compat reads provider-agnostic `spec.settings` values (aliases in parentheses):

- `modelProvider` (`model_provider`): underlying model provider (default from provider metadata)
- `voiceProvider` (`voice_provider`): underlying voice provider (default from provider metadata)
- `voice`: underlying voice id/name (default from provider metadata)
- `temperature`: clamped to `[0,2]` when provided
- `keepaliveEnabled` (`keepalive_enabled`): whether to stream silence keepalive frames (default from provider metadata)
- `keepaliveIntervalMs` (`keepalive_interval_ms`): keepalive interval in ms (default from provider metadata; clamped to `>= 50ms`)
