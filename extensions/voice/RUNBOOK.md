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

