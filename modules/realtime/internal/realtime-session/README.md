# Realtime Session (internal)

Realtime session controller that bridges provider/compat realtime sessions with adapter behavior (tool handling, timeouts, and observability).

## Entry points
- `index.ts`: exports `createRealtimeSessionController` and public types.
- `internal/*`: controller implementation and supporting helpers (timeouts, event handling, tool handling, encoding utilities).

## Responsibilities
- Coordinate a realtime session lifecycle (open → events → close).
- Apply adapter policies (timeouts, buffering, structured errors).
- Optionally track observability events for realtime sessions.
- Invoke tools when tool-call events are produced by the compat session.

## Import rules
- Runtime code should import from `modules/realtime/index.ts`.
- Do not import from `modules/realtime/internal/realtime-session/internal/**` outside of `modules/realtime`.

