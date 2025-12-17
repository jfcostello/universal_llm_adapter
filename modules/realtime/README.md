# `modules/realtime`

Provider-agnostic realtime session coordinator.

## Public API
- `createRealtimeSession(registry, spec)` → `RealtimeSession`
- `RealtimeSession`:
  - `events()` (async iterator of normalized `RealtimeEvent`s)
  - `sendText({ text, role? })`
  - `sendAudio(frame)`
  - `commit()`
  - `interrupt({ reason? })`
  - `close()`

Types are exported from this module for convenience:
- `RealtimeSessionSpec`
- `RealtimeAudioFrame`
- `RealtimeEvent`

## Architecture
- Core is provider-agnostic and loads the provider-specific realtime compat lazily via `registry.getRealtimeCompat(kind)`.
- Provider-specific realtime implementations live under `plugins/realtime-compat/*`.
- Tools are executed via the existing tool routing system only when enabled by `spec.functionToolNames`.

## Timeouts (MVP)
Timeouts are enforced per-session via `spec.timeout`:
- `maxDurationMs` (default 10 minutes)
- `idleTimeoutMs` (default 60 seconds)
- `onTimeout` (`close` or `warn`, default `close`)

Timeouts emit a normalized `timeout` event, and when `onTimeout=close` the session is closed.

