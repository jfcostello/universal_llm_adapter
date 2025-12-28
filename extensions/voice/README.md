# `extensions/voice`

Provider-agnostic voice calling capability layered on top of the core realtime APIs.

This extension is:
- **disabled by default**
- **strictly lazy-loaded** (only imported when enabled)
- **provider-agnostic** (provider-specific telephony logic lives under `plugins/voice-*`)

## Surface (planned)

Server endpoints:
- `POST /voice/calls`
- `GET|POST /voice/webhook`
- `WS /voice/media`

CLI:
- `llm-adapter voice ...`

