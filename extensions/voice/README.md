# `extensions/voice`

Provider-agnostic voice calling capability layered on top of the core realtime APIs.

This extension is:
- **disabled by default**
- **strictly lazy-loaded** (only imported when enabled)
- **provider-agnostic** (provider-specific telephony logic lives under `plugins/voice-*`)

## Surface

Server endpoints:
- `POST /voice/calls`
- `GET|POST /voice/webhook`
- `WS /voice/media`

CLI:
- `llm-adapter voice call`

## Enabling

Enable the voice extension on the server via:
- Config: `server.extensions.enabled: ["voice"]`
- CLI: `llm-adapter serve --extension voice`

## Observability

### Structured logs (redacted)

The voice extension emits structured lifecycle logs via the core logging module. Logs are designed to be correlation-friendly and **never** include prompts or raw media frames.

Common fields:
- `callConfigId`
- `voiceProvider` (ID only)
- `providerCallId` / `providerStreamId` (when available)
- `realtimeSessionId` (when available)

Event names + fields:
- `voice.calls.accepted` → `{ callConfigId, voiceProvider, hasIdempotencyKey }`
- `voice.calls.idempotency_hit` → `{ voiceProvider, callConfigId?, providerCallId? }`
- `voice.calls.idempotency_in_progress` → `{ voiceProvider }`
- `voice.calls.queued` → `{ callConfigId, voiceProvider, providerCallId }`
- `voice.calls.error` → `{ callConfigId?, voiceProvider, statusCode, code? }`

- `voice.webhook.request` → `{ callConfigId, voiceProvider, method }`
- `voice.webhook.validation_failed` → `{ callConfigId, voiceProvider, statusCode, code? }`
- `voice.webhook.response` → `{ callConfigId, voiceProvider, status }`
- `voice.webhook.error` → `{ callConfigId, voiceProvider, statusCode, code? }`

- `voice.media.connected` → `{ callConfigId, voiceProvider }`
- `voice.media.closed` → `{ callConfigId, voiceProvider, code }`
- `voice.media.ws_error` → `{ callConfigId, voiceProvider, message }`
- `voice.media.error` → `{ callConfigId, voiceProvider, code?, message }`

- `voice.media.stream_started` → `{ callConfigId, voiceProvider, providerStreamId, providerCallId }`
- `voice.realtime.ready` → `{ callConfigId, voiceProvider, providerStreamId, realtimeSessionId }`
- `voice.media.bridge_error` → `{ callConfigId, voiceProvider, providerStreamId?, providerCallId?, code, message }`

### Metrics (optional)

When enabled, the voice extension exposes a lightweight JSON metrics snapshot endpoint:
- `GET /voice/metrics`

Enable via:
- `LLM_ADAPTER_VOICE_METRICS_ENABLED=1`

Metric samples:
- `voice.calls.outbound_attempt_total` (counter) → labels: `{ voiceProvider }`
- `voice.compat.error_total` (counter) → labels: `{ voiceProvider, stage }`
  - `stage` values: `webhook_validate`, `webhook_response`, `outbound_call`, `media_connection`, `media_bridge`
- `voice.media.ws_active` (gauge) → labels: `{ voiceProvider }`
- `voice.media.ws_open_total` (counter) → labels: `{ voiceProvider }`
- `voice.media.ws_close_total` (counter) → labels: `{ voiceProvider }`
- `voice.media.ws_error_total` (counter) → labels: `{ voiceProvider }`

### Reliability (WS guardrails)

Media WS guardrails (server-side):
- `LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS` (default: `1000`)
- `LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES` (default: `1048576`)

Shutdown behavior:
- On server shutdown, the extension enters a **draining** mode and rejects new `WS /voice/media` upgrades with `503`.

Runbook + load exercise:
- `extensions/voice/RUNBOOK.md`

## CLI: `llm-adapter voice call`

Creates an outbound voice call by calling the server `POST /voice/calls` endpoint.

Required:
- `--server-url <url>`
- `--to <number>`
- `--from <number>`
- `--voice-provider <id>`
- Realtime spec via `--realtime-spec <json>` or `--realtime-spec-file <path>`

System prompt sources (optional):
- `--system-prompt <text>`
- `--system-prompt-file <path>`
- stdin (only when stdin is not a TTY)
