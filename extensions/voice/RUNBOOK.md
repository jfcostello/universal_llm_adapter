# Voice Extension Runbook

## Quick checklist

- Voice extension enabled on the server (`server.extensions.enabled: ["voice"]` or `llm-adapter serve --extension voice`).
- `LLM_ADAPTER_VOICE_WS_TOKEN_SECRET` set (required for `/voice/webhook` → `/voice/media` token minting).
- Shared call-config store configured (recommended for horizontal scaling).
- Auth enabled for `POST /voice/calls` if you expose it publicly.
- WS guardrails tuned for your target concurrency:
  - `LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS`
  - `LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES`
- Metrics/logging enabled as needed:
  - `LLM_ADAPTER_VOICE_METRICS_ENABLED=1` for `GET /voice/metrics`

## Call events (SSE)

The server can stream per-call lifecycle + transcript events via:
- `GET /voice/calls/:callConfigId/events` (requires server auth)

Example:

```bash
curl -N "http://127.0.0.1:3000/voice/calls/<callConfigId>/events" \\
  -H "x-api-key: <serverApiKey>"
```

Notes:
- Use `?includeDeltas=0` to reduce event volume if you only need final transcript events.
- In multi-instance deployments, ensure SSE requests route to the same instance handling the call’s media WS (or use a shared event bus).

## Ending calls

To terminate a live call:
- `POST /voice/calls/:callConfigId/end` (requires server auth)

```bash
curl -sS -X POST "http://127.0.0.1:3000/voice/calls/<callConfigId>/end" \\
  -H "x-api-key: <serverApiKey>"
```

Notes:
- Call termination requires the call to have a provider call id; if it is missing you’ll see `409 not_ready`.

## Recording download

Provider-side recording support is surfaced via:
- `POST /voice/webhook/recording` (provider callback; requires a call config with recording enabled)
- `GET /voice/calls/:callConfigId/recording` (requires server auth)

```bash
curl -L "http://127.0.0.1:3000/voice/calls/<callConfigId>/recording" \\
  -H "x-api-key: <serverApiKey>" \\
  -o call.<ext>
```

Notes:
- If recording is enabled but not ready yet, the download endpoint returns `409 recording_not_ready`.

## Local load exercise

This repo includes a small local load exercise script under:
- `extensions/voice/scripts/load-exercise.mjs`

It is designed to use the **test** voice compat (no external telephony provider required) to sanity-check concurrency behavior.

### Prereqs

```bash
npm install
npm run build
```

### Run

```bash
node extensions/voice/scripts/load-exercise.mjs --calls 200 --concurrency 50
```

Notes:
- The script starts an in-process server (random port) with auth enabled and the voice extension enabled.
- Override the auth key via `LLM_ADAPTER_LOAD_API_KEY`.
- Pass `--server-url <url>` to target an already-running server instead of starting one.

### Interpreting results

- `Calls: X/Y ok` should be close to `Y` locally; failures are usually auth/config issues.
- `Webhooks: X/Y ok` should match; failures usually indicate missing/expired call config state.
- `WS: X/Y ok` and `ready: X/Y` validate upgrade + basic message flow.

## Scaling guidance (high-level)

- Prefer **stateless** instances behind a load balancer.
- Use a **shared store** for call config + idempotency so any instance can serve `/voice/webhook` and `/voice/media`.
- Enable draining on shutdown (already built-in): instances reject new `/voice/media` upgrades during close.

## Common failure modes

- `401` on `/voice/media`:
  - missing/expired token, nonce replay, or token secret mismatch.
- `404` on `/voice/webhook`:
  - call config missing/expired in the configured store.
- `503` on `/voice/media`:
  - instance is draining or at the configured WS concurrency limit.
