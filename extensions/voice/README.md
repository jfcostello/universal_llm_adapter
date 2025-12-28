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
- `GET /voice/metrics` (optional)

CLI:
- `llm-adapter voice call`

## Enabling

Enable the voice extension on the server via:
- Config: `server.extensions.enabled: ["voice"]`
- CLI: `llm-adapter serve --extension voice`

## Configuration

### Required env vars

- `LLM_ADAPTER_VOICE_WS_TOKEN_SECRET` (required)
  - Used to mint and verify signed WS tokens for `WS /voice/media`.
  - Must be stable across instances.

### Optional env vars

- `LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS` (default: `300`)
  - TTL for the signed `WS /voice/media` token minted by `/voice/webhook` and `/voice/calls`.

- `LLM_ADAPTER_VOICE_CALL_CONFIG_STORE` (default: `memory`)
  - Store implementation for call configs, idempotency keys, and nonce replay protection.
  - Use `redis` for horizontal scaling.

- `LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL` (required when store=`redis`)
  - Redis connection URL for the shared call-config store.

- `LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX` (optional)
  - Redis key prefix (default: `llm_adapter:voice:v1:`).

- `LLM_ADAPTER_VOICE_PUBLIC_BASE_URL` (optional)
  - Explicit public base URL used to mint `WS /voice/media` URLs (recommended behind proxies).

- `LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS` (default: off)
  - When enabled, `x-forwarded-proto` / `x-forwarded-host` are trusted for public URL derivation.

### Provider plugins

Voice providers are configured via plugin manifests under:
- `plugins/voice-providers/*.json` (provider IDs + compat kind + optional defaults)
- `plugins/voice-compat/*` (compat implementations)

The voice extension itself is provider-agnostic; provider-specific behavior lives in those plugin directories.

### Webhook validation (signatures)

`/voice/webhook` requests are validated by the active provider compat.

Some compats require signature headers and shared secrets; see the relevant compat README under `plugins/voice-compat/*` for the exact header names and required environment variables.

### Public base URL / proxies

`/voice/webhook` needs to generate a public `WS /voice/media` URL for the telephony provider to connect to.

The extension derives the public HTTP base URL from:
- `LLM_ADAPTER_VOICE_PUBLIC_BASE_URL` (recommended; explicit override)
- otherwise `x-forwarded-proto` / `x-forwarded-host` (only when `LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS=1`)
- otherwise `Host` (and whether the socket is encrypted)

If you run behind a reverse proxy/load balancer, ensure it forwards those headers correctly.

## End-to-end flows

### Outbound call

1. Client calls `POST /voice/calls` (server-side) to create a call config and request an outbound call.
2. Provider places the outbound call and hits `GET|POST /voice/webhook?callConfigId=<id>`.
3. The webhook response instructs the provider to connect to `WS /voice/media?token=<...>`.
4. The provider streams audio over the media WS; the compat bridges into the core realtime session APIs.

### Inbound call

Inbound calls require a pre-existing `callConfigId` and stored call config (e.g., created by your own system).

1. Your system stores a call config under a stable `callConfigId`.
2. Your telephony provider is configured to call `GET|POST /voice/webhook?callConfigId=<id>` for inbound calls.
3. The provider connects to `WS /voice/media` using the minted token returned in the webhook response.

## Examples

### Local dry run (no external telephony provider)

This repo includes a local test voice compat that exercises `/voice/webhook` → `/voice/media` without calling any external telephony provider.

- Manifest: `plugins/voice-providers/test.json`
- Compat: `plugins/voice-compat/test`

Start a local server (voice extension enabled) and set a token secret:

```bash
export LLM_ADAPTER_VOICE_WS_TOKEN_SECRET="dev_secret"
export LLM_ADAPTER_API_KEYS="dev_key_1"
llm-adapter serve --auth-enabled --extension voice --port 3000
```

Create a call config via `POST /voice/calls` (requires server auth to be enabled):

```bash
curl -sS http://127.0.0.1:3000/voice/calls \\
  -H "x-api-key: dev_key_1" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "<to>",
    "from": "<from>",
    "voiceProvider": "test",
    "realtimeSpec": {}
  }'
```

Fetch the webhook response (some provider compats require signature headers; the local test compat expects `x-test-signature: ok`):

```bash
curl -sS "http://127.0.0.1:3000/voice/webhook?callConfigId=<callConfigId>" \\
  -H "x-test-signature: ok"
```

Open the returned `WS /voice/media` URL with any WebSocket client.

For higher concurrency, run the local load exercise:

```bash
npm run build
node extensions/voice/scripts/load-exercise.mjs --calls 200 --concurrency 50
```

### Public URL (public tunnel)

Expose your local server with a public URL, then configure your telephony provider to call:
- `GET|POST <publicBaseUrl>/voice/webhook?callConfigId=<id>`

Ensure `x-forwarded-proto` / `x-forwarded-host` are correct so the server generates a working public `WS /voice/media` URL.

## Deployment and scaling (high-level)

- Keep `LLM_ADAPTER_VOICE_WS_TOKEN_SECRET` consistent across instances.
- For horizontal scaling, configure a shared call config + idempotency store (`LLM_ADAPTER_VOICE_CALL_CONFIG_STORE=redis`).
- Ensure your proxy/load balancer supports WebSocket and forwards `x-forwarded-*`.
- Enable server auth + rate limiting when exposing `POST /voice/calls` and `GET /voice/metrics`.

## Testing

- Voice extension suite: `npm run test:extensions:voice`

## Observability

### Structured logs (redacted)

The voice extension emits structured lifecycle logs via the core logging module. Logs are designed to be correlation-friendly and **never** include prompts or raw media frames.

Common fields:
- `callConfigId`
- `requestId` (when provided on `POST /voice/calls`)
- `voiceProvider` (ID only)
- `providerCallId` / `providerStreamId` (when available)
- `realtimeSessionId` (when available)

Event names + fields:
- `voice.calls.accepted` → `{ callConfigId, voiceProvider, hasIdempotencyKey, requestId? }`
- `voice.calls.idempotency_hit` → `{ voiceProvider, callConfigId?, providerCallId? }`
- `voice.calls.idempotency_in_progress` → `{ voiceProvider }`
- `voice.calls.queued` → `{ callConfigId, voiceProvider, providerCallId, requestId? }`
- `voice.calls.error` → `{ callConfigId?, voiceProvider, statusCode, code?, requestId? }`

- `voice.webhook.request` → `{ callConfigId, voiceProvider, method, requestId? }`
- `voice.webhook.validation_failed` → `{ callConfigId, voiceProvider, statusCode, code?, requestId? }`
- `voice.webhook.response` → `{ callConfigId, voiceProvider, status, requestId? }`
- `voice.webhook.error` → `{ callConfigId, voiceProvider, statusCode, code?, requestId? }`

- `voice.media.connected` → `{ callConfigId, voiceProvider, requestId? }`
- `voice.media.closed` → `{ callConfigId, voiceProvider, code, requestId? }`
- `voice.media.ws_error` → `{ callConfigId, voiceProvider, message, requestId? }`
- `voice.media.error` → `{ callConfigId, voiceProvider, code?, message, requestId? }`

- `voice.media.stream_started` → `{ callConfigId, voiceProvider, providerStreamId, providerCallId, requestId? }`
- `voice.realtime.ready` → `{ callConfigId, voiceProvider, providerStreamId, realtimeSessionId, requestId? }`
- `voice.media.bridge_error` → `{ callConfigId, voiceProvider, providerStreamId?, providerCallId?, code, message, requestId? }`

### Metrics (optional)

When enabled, the voice extension exposes a lightweight JSON metrics snapshot endpoint:
- `GET /voice/metrics`

This endpoint requires server auth to be enabled.

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
- `--api-key <key>`
- `--to <number>`
- `--from <number>`
- `--voice-provider <id>`
- Realtime spec via `--realtime-spec <json>` or `--realtime-spec-file <path>`

System prompt sources (optional):
- `--system-prompt <text>`
- `--system-prompt-file <path>`
- stdin (only when stdin is not a TTY)
