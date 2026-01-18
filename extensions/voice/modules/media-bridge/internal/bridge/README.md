# Voice Media WS Bridge (internal)

Provider-agnostic building blocks for bridging a provider media WebSocket to a realtime session.

Provider-specific message parsing / message-building must remain in `extensions/voice/plugins/compat/**`.

## Entry point
- `index.ts`: exports `createVoiceMediaWsBridge()` and the bridge types.

## Layout
- `internal/create-voice-media-ws-bridge.ts`: bridge factory and orchestration.
- `internal/session-pump.ts`: session-level coordination.
- `internal/inbound-pump.ts` / `internal/outbound-pump.ts`: inbound/outbound pumping with backpressure.
- `internal/dtmf-pump.ts`: DTMF message handling.
- `internal/ws-helpers.ts`: WebSocket utilities.
- `internal/types.ts`: protocol adapter and bridge types.

## Import rules
- Runtime code must import only from `extensions/voice/modules/media-bridge/index.ts`.
- Do not import from `extensions/voice/modules/media-bridge/internal/**` outside of the media-bridge module.

