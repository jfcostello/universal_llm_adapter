# `plugins/realtime-compat/grok`

Realtime compat for the Grok Voice Agent API (xAI) using the provider-agnostic realtime session interface (`IRealtimeCompat`).

This compat is loaded lazily via `PluginRegistry.getRealtimeCompat('grok')` and must not be imported by core code directly.

## Provider manifest

Create a realtime provider manifest at `plugins/realtime-providers/grok.json`:

```json
{
  "id": "grok",
  "compat": "grok",
  "endpoint": {
    "urlTemplate": "wss://api.x.ai/v1/realtime",
    "headers": {
      "Authorization": "Bearer ${XAI_API_KEY}"
    }
  },
  "metadata": {
    "defaultVoice": "ara"
  }
}
```

## Voice selection

- Default voice comes from `provider.metadata.defaultVoice`.
- Override at runtime via `spec.metadata.voice` when creating the session.

## Turn detection

- `turnDetection.mode = manual_commit` (default):
  - `session.commit()` sends `input_audio_buffer.commit` (when audio was provided) and `response.create`.
- `turnDetection.mode = server_vad`:
  - Provider is expected to auto-create responses for audio turns.
  - `session.commit()` only sends `response.create` for **text turns** (e.g. typed input / DTMF), avoiding duplicate turns for telephony bridges that commit on `user_speech.stopped`.

## Response creation

When committing a turn, this compat always requests both text and audio output:

- `response.modalities = ['text', 'audio']`

If a tool choice is supplied by the session controller, it is forwarded as `response.tool_choice`.

## Provider event logging (debug)

Set `LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS=<ms>` to log raw provider events for the first N milliseconds after the session becomes `ready`.

Notes:
- Logging is best-effort; failures to initialize logging are ignored.
- Base64 audio payloads in `response.output_audio.delta` events are redacted (`[REDACTED_BASE64]`), but other fields (including transcripts) are logged as-is.
