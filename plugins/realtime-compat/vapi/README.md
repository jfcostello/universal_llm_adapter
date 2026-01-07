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
- `spec.settings.modelProvider` is validated against `provider.metadata.supportedModelProviders` (from `plugins/realtime-providers/vapi.json`) to fail fast on invalid values.
- Tool calling: Vapi’s primary supported tool-result loop is server-webhook based. This compat implements a best-effort local tool loop by injecting tool output back into the call context.
- Tool result fallback: if no assistant activity is observed shortly after sending tool results, the compat may issue a `say` control message with the tool result content to prevent deadlocks in voice-first flows.

## Session settings

This compat reads provider-agnostic `spec.settings` values (aliases in parentheses):

### Core model/voice

- `modelProvider` (`model_provider`): underlying model provider (default from provider metadata)
- `wsHandshakeTimeoutMs` (`ws_handshake_timeout_ms`): WS handshake timeout for connecting to `transport.websocketCallUrl` (default from provider metadata; `0` disables explicit timeout)
- `voiceProvider` (`voice_provider`): underlying voice provider (default from provider metadata)
- `voice`: underlying voice id/name (default from provider metadata)
- `temperature`: forwarded to `assistant.model.temperature` (not clamped; Vapi validates)
- `maxOutputTokens` (`maxTokens`, `max_output_tokens`): forwarded to `assistant.model.maxTokens` (Vapi validates)
- `emotionRecognitionEnabled` (`emotion_recognition_enabled`): forwarded to `assistant.model.emotionRecognitionEnabled`
- `backgroundSound` (`background_sound`): forwarded to `assistant.backgroundSound`
- `speed`: forwarded to `assistant.voice.speed` (Vapi validates per voice provider)
- `inputMinCharacters` (`input_min_characters`): forwarded to `assistant.voice.chunkPlan.minCharacters`

### Turn detection / latency tuning

- `startSpeakingWaitSeconds` (`start_speaking_wait_seconds`): forwarded to `assistant.startSpeakingPlan.waitSeconds`
- `startSpeakingSmartEndpointingEnabled` (`smartEndpointingEnabled`, `smart_endpointing_enabled`): forwarded to `assistant.startSpeakingPlan.smartEndpointingEnabled` (deprecated in Vapi; still supported)
- `transcriptionEndpointingOnPunctuationSeconds` (`transcription_endpointing_on_punctuation_seconds`): forwarded to `assistant.startSpeakingPlan.transcriptionEndpointingPlan.onPunctuationSeconds`
- `transcriptionEndpointingOnNoPunctuationSeconds` (`transcription_endpointing_on_no_punctuation_seconds`): forwarded to `assistant.startSpeakingPlan.transcriptionEndpointingPlan.onNoPunctuationSeconds`
- `transcriptionEndpointingOnNumberSeconds` (`transcription_endpointing_on_number_seconds`): forwarded to `assistant.startSpeakingPlan.transcriptionEndpointingPlan.onNumberSeconds`
- `stopSpeakingNumWords` (`stop_speaking_num_words`): forwarded to `assistant.stopSpeakingPlan.numWords`
- `stopSpeakingVoiceSeconds` (`stop_speaking_voice_seconds`): forwarded to `assistant.stopSpeakingPlan.voiceSeconds`
- `stopSpeakingBackoffSeconds` (`stop_speaking_backoff_seconds`): forwarded to `assistant.stopSpeakingPlan.backoffSeconds`

### Transcriber (Deepgram Flux EOT)

Only applied when `transcription.enabled` is set and the resolved Vapi transcriber provider is `deepgram`:

- `transcriberEagerEotThreshold` (`transcriber_eager_eot_threshold`): forwarded to `assistant.transcriber.eagerEotThreshold`
- `transcriberEotThreshold` (`transcriber_eot_threshold`): forwarded to `assistant.transcriber.eotThreshold`
- `transcriberEotTimeoutMs` (`transcriber_eot_timeout_ms`): forwarded to `assistant.transcriber.eotTimeoutMs`

### Transport / tooling / control URL polling

- `keepaliveEnabled` (`keepalive_enabled`): whether to stream silence keepalive frames (default from provider metadata)
- `keepaliveIntervalMs` (`keepalive_interval_ms`): keepalive interval in ms (default from provider metadata; clamped to `>= 50ms`)
- `toolFallbackDelayMs` (`tool_fallback_delay_ms`): delay before the tool-result `say` fallback is triggered (`0` disables; default `5000`)
- `controlUrlPollMs` (`control_url_poll_ms`): call-details polling interval while waiting for `monitor.controlUrl` (default from provider metadata; clamped to `>= 100ms`)
- `controlUrlMaxWaitMs` (`control_url_max_wait_ms`): max time to wait for `monitor.controlUrl` before failing (default from provider metadata; clamped to `>= controlUrlPollMs`)
