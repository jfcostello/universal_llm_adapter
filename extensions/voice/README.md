# `extensions/voice`

Provider-agnostic voice calling capability layered on top of the core realtime APIs.

This extension is:
- **disabled by default**
- **strictly lazy-loaded** (only imported when enabled)
- **provider-agnostic** (provider-specific telephony logic lives under `plugins/{providers,compat}`)

## Surface

Server endpoints:
- `POST /voice/calls`
- `GET|POST /voice/webhook`
- `POST /voice/webhook/recording` (provider callback)
- `WS /voice/media`
- `GET /voice/calls/:callConfigId/events` (SSE; requires server auth)
- `POST /voice/calls/:callConfigId/end` (requires server auth)
- `POST /voice/calls/:callConfigId/transfer` (requires server auth)
- `GET /voice/calls/:callConfigId/recording` (requires server auth)
- `GET /voice/metrics` (optional)

CLI:
- `llm-adapter voice call`
- `llm-adapter voice events`
- `llm-adapter voice end`
- `llm-adapter voice transfer`
- `llm-adapter voice recording`

## Logging

When `modules/logging` is available, the voice extension emits JSONL file logs under:
- `logs/voice/`

If the active voice compat supports it, provider-side artifacts may also be persisted under nested subdirectories (for example: `logs/voice/<voiceProvider>/...`).

Retention:
- `LLM_ADAPTER_VOICE_LOG_MAX_FILES`
- `LLM_ADAPTER_VOICE_LOG_MAX_AGE_DAYS`

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
  - Max: `86400` (tokens above this TTL are rejected to avoid downstream verification mismatches).

- `LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED` (default: on)
  - When enabled (default), the active voice compat **must** implement `validateWebhookRequest()` and `/voice/webhook` will reject requests if validation isn’t available.
  - For local/dev only, set `LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED=0` to allow missing webhook validation.

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
  - When enabled, `x-forwarded-proto` / `x-forwarded-host` are used for public URL derivation (invalid values are ignored and the server falls back to the socket/`Host`).

- `LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS` (default: `30000`)
  - Max time the server will wait for upstream recording downloads when proxying `GET /voice/calls/:callConfigId/recording` (also aborted on client disconnect).

- `LLM_ADAPTER_VOICE_EVENTS_KEEPALIVE_INTERVAL_MS` (default: `15000`)
  - Overrides the default SSE keepalive interval (`server.extensions.voice.events.keepAliveIntervalMs`). Set to `0` to disable keepalives.

- `LLM_ADAPTER_VOICE_MEDIA_WS_TOKEN_FROM_MESSAGE_TIMEOUT_MS` (default: `5000`)
  - Enables accepting the signed `WS /voice/media` token via the first WebSocket message (JSON key: `voiceMediaToken`) when URL query parameters can't be preserved.
  - Set to `0` to disable and require `?token=...` in the URL.

- `LLM_ADAPTER_VOICE_TRANSFER_DEFAULT_TIMEOUT_SECONDS` (default: `30`)
  - Overrides the default ring timeout for blind call transfers (`server.extensions.voice.transfer.defaultTimeoutSeconds`). Range: 1-600 seconds.

### Server defaults (optional)

The voice extension supports server-side defaults and settings under `server.extensions.voice`:

Call defaults (applied to `POST /voice/calls` when a field is omitted):
- `assistantFirstTurn`: `{ enabled, prompt, role, delayMs, missingPromptBehavior }`
- `timeouts`: `{ callTimeoutMs, silenceTimeoutMs, firstTurnGraceMs, silenceAssistantAudioStartFallbackMs, silenceAssistantAudioEndFallbackMs }`
- `recording`: `{ enabled, mode, format, channels }`

Events stream defaults/settings (applied to `GET /voice/calls/:callConfigId/events`):
- `events`: `{ includeDeltas, keepAliveIntervalMs, maxWriteQueueBytes, maxActiveCalls, maxBufferedEventsPerCall, callTtlMs }`

Call end defaults/settings (applied to `POST /voice/calls/:callConfigId/end`):
- `end`: `{ defaultMode, defaultMaxWaitMs, defaultCancelOnUserSpeech }`

Call transfer defaults/settings (applied to `POST /voice/calls/:callConfigId/transfer`):
- `transfer`: `{ defaultTimeoutSeconds }`

Notes:
- `events.maxActiveCalls` (default: `20000`): cap on in-memory active call channels for the SSE events hub.
- `events.maxBufferedEventsPerCall` (default: `200`): number of most-recent non-delta events kept per call for replay (set `0` to disable replay buffering).
- Memory: `events.maxActiveCalls` and `events.maxBufferedEventsPerCall` effectively multiply; if you don’t need replay at high concurrency, set `events.maxBufferedEventsPerCall=0`.
- `events.callTtlMs` (default: `900000`): sweep inactive call channels after this TTL (set `0` to disable TTL-based sweeping).
- `events.keepAliveIntervalMs` (default: `15000`): interval for SSE keepalive comments (`: keepalive`) to keep intermediaries from timing out idle streams (set `0` to disable keepalives). Can also be overridden via `LLM_ADAPTER_VOICE_EVENTS_KEEPALIVE_INTERVAL_MS`.
- `events.maxWriteQueueBytes` (default: `262144`): upper bound on buffered SSE response bytes (in-flight + queued). If exceeded, the server closes the stream to avoid unbounded memory growth.
- `end.defaultMode` (default: `immediate`): `{ immediate | after_assistant_audio | after_playback }`.
- `end.defaultMaxWaitMs` (default: `5000`, max: `60000`): safety fallback for graceful call ends.
- `end.defaultCancelOnUserSpeech` (default: `false`): cancel a pending graceful end when `user_speech.started` is observed.
- `transfer.defaultTimeoutSeconds` (default: `30`, range: `1-600`): ring timeout for blind call transfers. When a call is transferred, the target phone rings for this many seconds before the call ends if unanswered.
- `timeouts.firstTurnGraceMs`: optional non-negative millisecond window used by some voice compats/bridges to adjust first-turn commit behavior immediately after realtime `ready` (see the active compat README under `plugins/compat/*`).
- `timeouts.silenceAssistantAudioStartFallbackMs` / `timeouts.silenceAssistantAudioEndFallbackMs`: optional fallback windows used by some provider compats when `assistantFirstTurn.enabled=true` to ensure silence timers still arm when assistant-audio boundary events are missing (see the active compat README under `plugins/compat/*`).

Media WS settings:
- `mediaWs`: `{ tokenFromMessageTimeoutMs }`

### Provider plugins

Voice providers are configured via plugin manifests under:
- `plugins/providers/*.json` (provider IDs + compat kind + optional defaults)
- `plugins/compat/*` (compat implementations)

The voice extension itself is provider-agnostic; provider-specific behavior lives in those plugin directories.

#### Multi-root plugin resolution

The voice extension searches for provider manifests and compat modules across **multiple plugin roots** in priority order:

1. **External roots** from `llm-adapter.paths.json` (if configured)
2. **Package root** (`dist/extensions/voice/plugins`)
3. **Current working directory** (`extensions/voice/plugins`)

**Manifest combination:** Manifests from all roots are combined. This allows external packs to add additional voice providers alongside built-in providers. If the same provider ID appears in multiple roots, an error is thrown to prevent conflicts.

**Compat resolution:** Compat modules are resolved using first-match-wins across roots. The extension searches each root in priority order and uses the first matching compat module found.

This multi-root approach handles TypeScript projects where compiled JS (compats) may be in `dist/` but JSON manifests remain in source directories.

### Webhook validation (signatures)

`/voice/webhook` requests are validated by the active provider compat.

Some compats require signature headers and shared secrets; see the relevant compat README under `plugins/compat/*` for the exact header names and required environment variables.

By default, webhook validation is **required**. If the active compat does not implement `validateWebhookRequest()`, `/voice/webhook` returns `501` with code `webhook_validation_unavailable`.

For local/dev only, set `LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED=0` to allow missing validation.

### Webhook request bodies

`POST /voice/webhook` supports:
- `application/x-www-form-urlencoded` (exposed to the compat as `params` + raw `bodyText`)
- `application/json` (exposed to the compat as parsed `body` + raw `bodyText`)

If a JSON body is empty, it is treated as `{}`. If JSON parsing fails, the request is still processed and the raw `bodyText` is passed through so the compat can validate/reject it.

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
3. The webhook response instructs the provider to connect to `WS /voice/media` with a signed token (usually as `?token=...`, or provided in the first WS message when query params can’t be preserved).
4. The provider streams audio over the media WS; the compat bridges into the core realtime session APIs.

Notes:
- `POST /voice/calls` supports idempotency via the `Idempotency-Key` header or `idempotencyKey` JSON body field. Keys are trimmed; extremely large keys are stored via a stable hash to keep store keys bounded.
- Consumers can subscribe to real-time call events (including transcripts) via `GET /voice/calls/<callConfigId>/events` (SSE).
- When enabled, recordings can be fetched via `GET /voice/calls/<callConfigId>/recording`. Some providers also send provider-side recording callbacks to `POST /voice/webhook/recording`.

### Inbound call

Inbound calls require a pre-existing `callConfigId` and stored call config (e.g., created by your own system).

1. Your system stores a call config under a stable `callConfigId`.
2. Your telephony provider is configured to call `GET|POST /voice/webhook?callConfigId=<id>` for inbound calls.
3. The provider connects to `WS /voice/media` using the minted token returned in the webhook response.

#### Media WS token delivery

By default, the token is included in the `WS /voice/media` URL query as `?token=...`.

If your provider cannot preserve WebSocket URL query parameters, the server can instead accept the token from the first WS message. Send a JSON message containing a `voiceMediaToken` string immediately after connect.

This behavior is controlled by `server.extensions.voice.mediaWs.tokenFromMessageTimeoutMs` (default: `5000`). Set it to `0` to require `?token=...` in the URL.

## Examples

### Local dry run (no external telephony provider)

This repo includes a local test voice compat that exercises `/voice/webhook` → `/voice/media` without calling any external telephony provider.

- Manifest: `plugins/providers/test.json`
- Compat: `plugins/compat/test`

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
    "realtimeSpec": {},
    "assistantFirstTurn": {
      "enabled": true,
      "prompt": "Greet the user briefly and ask how you can help.",
      "role": "user",
      "delayMs": 250,
      "missingPromptBehavior": "reject"
    },
    "timeouts": {
      "callTimeoutMs": 600000,
      "silenceTimeoutMs": 30000
    },
    "recording": {
      "enabled": false,
      "mode": "provider",
      "format": "mp3",
      "channels": "mono"
    }
  }'
```

Fetch the webhook response (some provider compats require signature headers; the local test compat expects `x-test-signature: ok`):

```bash
curl -sS "http://127.0.0.1:3000/voice/webhook?callConfigId=<callConfigId>" \\
  -H "x-test-signature: ok"
```

Open the returned `WS /voice/media` URL with any WebSocket client.

For higher concurrency sanity-checks, run the voice extension test suite (includes a concurrent webhook → media integration test via the built-in test compat):

```bash
npm run test:extensions -- --testPathPattern=extensions/voice
```

### Public URL (public tunnel)

Expose your local server with a public URL, then configure your telephony provider to call:
- `GET|POST <publicBaseUrl>/voice/webhook?callConfigId=<id>`

Ensure `x-forwarded-proto` / `x-forwarded-host` are correct so the server generates a working public `WS /voice/media` URL.

## Deployment and scaling (high-level)

- Keep `LLM_ADAPTER_VOICE_WS_TOKEN_SECRET` consistent across instances.
- For horizontal scaling, configure a shared call config + idempotency store (`LLM_ADAPTER_VOICE_CALL_CONFIG_STORE=redis`).
- `GET /voice/calls/:callConfigId/events` is emitted by the instance handling the call’s media WS; use sticky routing or a shared event bus if you need to consume events from a different instance.
- Ensure your proxy/load balancer supports WebSocket and forwards `x-forwarded-*`.
- Enable server auth + rate limiting when exposing `POST /voice/calls` and `GET /voice/metrics`.

## Testing

- Voice extension suite: `npm run test:extensions -- --testPathPattern=extensions/voice`

## Observability

### Structured logs (redacted)

The voice extension emits structured lifecycle logs via the core logging module. Logs are designed to be correlation-friendly and **never** include prompts or raw media frames.

Common fields:
- `callConfigId`
- `requestId` (when provided on `POST /voice/calls`; sanitized and capped)
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

Other options (optional):
- `--api-key-header-name <name>` (default: `x-api-key`)
- `--idempotency-key <key>`
- `--ttl-seconds <seconds>` (default: `900`)
- `--metadata <json>` / `--metadata-file <path>`
- `--provider-config <json>` / `--provider-config-file <path>`
- `--request-id <id>`
- `--assistant-first-turn <json>` / `--assistant-first-turn-file <path>`
- `--timeouts <json>` / `--timeouts-file <path>`
- `--recording <json>` / `--recording-file <path>`
- `--pretty`

## CLI: `llm-adapter voice events`

Streams `GET /voice/calls/:callConfigId/events` (SSE) as newline-delimited JSON.

Required:
- `--server-url <url>`
- `--call-config-id <id>`

Optional:
- `--api-key <key>`
- `--api-key-header-name <name>` (default: `x-api-key`)
- `--include-deltas 0|1`
- `--event-types <csv>` (comma-separated allowlist; maps to the `eventTypes` query param)

## CLI: `llm-adapter voice end`

Ends a call by calling `POST /voice/calls/:callConfigId/end`.

Required:
- `--server-url <url>`
- `--call-config-id <id>`

Optional:
- `--api-key <key>`
- `--api-key-header-name <name>` (default: `x-api-key`)
- `--mode <mode>` (`immediate|after_assistant_audio|after_playback`)
- `--max-wait-ms <ms>` (non-negative; max: `60000`)
- `--cancel-on-user-speech 0|1`

## CLI: `llm-adapter voice transfer`

Transfers a call to another phone number by calling `POST /voice/calls/:callConfigId/transfer`.

Required:
- `--server-url <url>`
- `--call-config-id <id>`
- `--target-number <number>` (E.164 format, e.g. `+14155551234`)

Optional:
- `--api-key <key>`
- `--api-key-header-name <name>` (default: `x-api-key`)
- `--caller-id <number>` (E.164 format; override caller ID shown to target)
- `--timeout <seconds>` (ring timeout, 1-600, default: 30)
- `--pretty` (pretty print output)

## CLI: `llm-adapter voice recording`

Downloads a recording via `GET /voice/calls/:callConfigId/recording`.

Required:
- `--server-url <url>`
- `--call-config-id <id>`

Optional:
- `--api-key <key>`
- `--api-key-header-name <name>` (default: `x-api-key`)
- `--output <path>` (defaults to stdout)

## Call ending (graceful hangup)

`POST /voice/calls/:callConfigId/end` supports immediate and graceful modes.

Request body (optional):

```json
{
  "mode": "after_playback",
  "maxWaitMs": 5000,
  "cancelOnUserSpeech": true
}
```

Modes:
- `immediate`: end the call immediately.
- `after_assistant_audio`: wait for `voice.assistant_audio.ended` then end.
- `after_playback`: wait for `voice.playback.drained` then end (requires compat support).

Behavior:
- For graceful modes, the server returns `{ ok: true, result: "scheduled" }` and performs termination asynchronously.
- `maxWaitMs` is a safety fallback; if the awaited event is not observed within `maxWaitMs`, the server ends the call.
- When `cancelOnUserSpeech=true`, a pending graceful end is canceled if `user_speech.started` is observed before termination.

Events:
- `voice.call.end_scheduled` (server scheduled a graceful end)
- `voice.call.end_requested` (provider termination requested)
- `voice.call.end_canceled` (graceful end canceled)
- `voice.call.end_failed` (termination attempt failed)

## Call transfer (blind transfer)

`POST /voice/calls/:callConfigId/transfer` performs a blind (cold) call transfer to another phone number.

Request body:

```json
{
  "targetNumber": "+14155551234",
  "callerId": "+15551234567",
  "timeout": 45
}
```

Fields:
- `targetNumber` (required): E.164 phone number to dial (e.g. `+14155551234`).
- `callerId` (optional): Override caller ID shown to target (E.164 format). Must be a verified Twilio number.
- `timeout` (optional): Ring timeout in seconds (1-600, default: 30).

Behavior:
- When the transfer is executed, the existing WebSocket media stream closes immediately.
- The caller hears ringing while the target phone rings.
- If the target answers, they're connected to the caller.
- If the target doesn't answer within the timeout, the call ends.

Response:

```json
{
  "ok": true,
  "result": "transferred",
  "targetNumber": "+14155551234"
}
```

Error handling:
- 400: Invalid `targetNumber` (not E.164) or `timeout` (out of range).
- 404: Unknown `callConfigId`.
- 409: Call is missing `providerCallId` (not yet connected).
- 501: Voice provider doesn't support call transfer.
- 502+: Provider API error (e.g. invalid `callerId`).

Events:
- `voice.call.transferred` (transfer initiated to `targetNumber`)

Example:

```bash
curl -X POST "http://127.0.0.1:3000/voice/calls/<callConfigId>/transfer" \
  -H "x-api-key: <serverApiKey>" \
  -H "Content-Type: application/json" \
  -d '{"targetNumber": "+14155551234"}'
```

## Runbook

### Quick checklist

- Voice extension enabled on the server (`server.extensions.enabled: ["voice"]` or `llm-adapter serve --extension voice`).
- `LLM_ADAPTER_VOICE_WS_TOKEN_SECRET` set (required for `/voice/webhook` → `/voice/media` token minting/verification).
- Shared call-config store configured (recommended for horizontal scaling).
- Auth enabled for `POST /voice/calls` if you expose it publicly.
- WS guardrails tuned for your target concurrency:
  - `LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS`
  - `LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES`
- Metrics/logging enabled as needed:
  - `LLM_ADAPTER_VOICE_METRICS_ENABLED=1` for `GET /voice/metrics`

### Call events (SSE)

Stream per-call lifecycle + transcript events via:
- `GET /voice/calls/:callConfigId/events` (requires server auth)

Example:

```bash
curl -N "http://127.0.0.1:3000/voice/calls/<callConfigId>/events" \
  -H "x-api-key: <serverApiKey>"
```

Notes:
- Use `?includeDeltas=0` to reduce event volume if you only need final transcript events.
- In multi-instance deployments, ensure SSE requests route to the same instance handling the call’s media WS (or use a shared event bus).

### Ending calls

To terminate a live call:
- `POST /voice/calls/:callConfigId/end` (requires server auth)

```bash
curl -sS -X POST "http://127.0.0.1:3000/voice/calls/<callConfigId>/end" \
  -H "x-api-key: <serverApiKey>"
```

Notes:
- Call termination requires the call to have a provider call id; if it is missing you’ll see `409 not_ready`.

### Recording download

Provider-side recording support is surfaced via:
- `POST /voice/webhook/recording` (provider callback; requires a call config with recording enabled)
- `GET /voice/calls/:callConfigId/recording` (requires server auth)

```bash
curl -L "http://127.0.0.1:3000/voice/calls/<callConfigId>/recording" \
  -H "x-api-key: <serverApiKey>" \
  -o call.<ext>
```

Notes:
- If recording is enabled but not ready yet, the download endpoint returns `409 recording_not_ready`.

### Scaling guidance (high-level)

- Prefer stateless instances behind a load balancer.
- Use a shared store for call config + idempotency so any instance can serve `/voice/webhook` and `/voice/media`.
- Enable draining on shutdown (already built-in): instances reject new `/voice/media` upgrades during close.

### Common failure modes

- `401` on `/voice/media`:
  - missing/expired token, nonce replay, or token secret mismatch.
- `404` on `/voice/webhook`:
  - call config missing/expired in the configured store.
- `503` on `/voice/media`:
  - instance is draining or at the configured WS concurrency limit.
