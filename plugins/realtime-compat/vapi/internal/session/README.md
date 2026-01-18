# Vapi Realtime Session (internal)

Creates and manages a realtime session over WebSocket, translating between the provider’s realtime protocol and the adapter’s canonical `RealtimeEvent` stream.

## Entry points
- `index.ts`: exports `createVapiRealtimeCompatSession`.
- `internal/*`: session planning, API calls, audio/tool handling, and WebSocket event handlers.

## Responsibilities
- Create the websocket call and resolve the control URL used for control-plane commands.
- Establish the realtime WebSocket connection with the appropriate handshake configuration.
- Map inbound websocket events to adapter `RealtimeEvent`s and enqueue them.
- Provide a `RealtimeCompatSession` implementation (send text/audio, commit, interrupt, tool results, close).

## Import rules
- Only `plugins/realtime-compat/vapi/index.ts` should import from `plugins/realtime-compat/vapi/internal/session/index.ts`.
- Do not import from `plugins/realtime-compat/vapi/internal/session/internal/**` outside of this plugin.

