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

## Extended session settings

Pass extended settings via `spec.settings`. All settings support both camelCase and snake_case aliases.

| Setting | Type | Description |
|---------|------|-------------|
| `voice` | string | Voice identifier (overrides `spec.metadata.voice` and default) |
| `temperature` | number | Sampling temperature |
| `vadThreshold` | number | VAD activation threshold (0.0-1.0, server_vad only) |
| `vadPrefixPaddingMs` | int | Audio padding before speech detection (server_vad only) |
| `vadSilenceDurationMs` | int | Silence duration to end turn (server_vad only) |
| `enableWebSearch` | boolean | Enable Grok's built-in web search tool |
| `enableXSearch` | boolean | Enable Grok's built-in X (Twitter) search tool |
| `enableFileSearch` | boolean | Enable Grok's built-in file search tool |

Note: `int` values are parsed as **positive integers (>0)**.

Example:
```ts
const session = await createRealtimeSession(registry, {
  provider: 'grok',
  model: 'grok-2-realtime',
  turnDetection: { mode: 'server_vad' },
  settings: {
    voice: 'sage',
    temperature: 0.9,
    vad_threshold: 0.5,
    vad_prefix_padding_ms: 200,
    vad_silence_duration_ms: 400,
    enable_web_search: true,
    enable_x_search: true
  }
});
```

When built-in tools are enabled, they are automatically added to the session tools array alongside any function tools you provide.

Note: `toolChoice.allowed` filtering applies only to function tools. Built-in tools enabled via `spec.settings` are always added.

## Provider event logging (debug)

Set `LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS=<ms>` to log raw provider events for the first N milliseconds after the session becomes `ready`.

Optional tuning:
- `LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MAX_QUEUE=<n>` (default: 200, max: 1000)
- `LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_BATCH_SIZE=<n>` (default: 25, capped to `MAX_QUEUE`)

Notes:
- Logging is best-effort; failures to initialize logging are ignored.
- Logging is non-blocking and bounded. If the queue is overwhelmed or the log window expires while backlogged, provider-event logs may be dropped and a one-time `realtime.provider_event.dropped` warning is emitted with drop counts.
- Base64 audio payloads in `response.output_audio.delta` events are redacted (`[REDACTED_BASE64]`), but other fields (including transcripts) are logged as-is.
