# Voice Media Bridge Module

Provider-agnostic building blocks for bridging provider media WebSockets to realtime sessions.

Provider-specific message parsing and message-building must remain in `extensions/voice/plugins/compat/**`.

## Import rules
- Runtime code must import only from `extensions/voice/modules/media-bridge/index.ts`.
- Do not import from `extensions/voice/modules/media-bridge/internal/**` outside of this module.

