# Voice Server (internal)

Owns registration and handler wiring for the voice extension on top of an existing Node `http.Server`.

## Entry point
- `index.ts`: `createVoiceServerRegistration(...)` returns `{ handleHttp, handleUpgrade, close }`.

## Responsibilities
- Normalize extension config and defaults.
- Wire auth + rate limiting gates (using core server/auth modules).
- Resolve voice provider plugins (through the voice plugin registry).
- Register HTTP handlers for call control, events, and webhooks.
- Register WS upgrade handling for media sessions.
- Manage per-call event hub + metrics wiring.

## Layout
- `internal/config/*`: env/default normalization and public URL helpers.
- `internal/core/*`: shared types and logger/context helpers.
- `internal/http/*`: HTTP route handlers and HTTP utilities.
- `internal/ws/*`: WebSocket upgrade/session handling and WS utilities.

## Import rules
- Runtime code must import only from `extensions/voice/modules/server/index.ts`.
- Do not import from `extensions/voice/modules/server/internal/**` outside of the voice server module.
