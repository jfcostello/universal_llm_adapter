# `extensions/voice`

Provider-agnostic voice calling capability layered on top of the core realtime APIs.

This extension is:
- **disabled by default**
- **strictly lazy-loaded** (only imported when enabled)
- **provider-agnostic** (provider-specific telephony logic lives under `plugins/voice-*`)

## Surface

Server endpoints:
- `POST /voice/calls`
- `GET|POST /voice/webhook`
- `WS /voice/media`

CLI:
- `llm-adapter voice call`

## Enabling

Enable the voice extension on the server via:
- Config: `server.extensions.enabled: ["voice"]`
- CLI: `llm-adapter serve --extension voice`

## CLI: `llm-adapter voice call`

Creates an outbound voice call by calling the server `POST /voice/calls` endpoint.

Required:
- `--server-url <url>`
- `--to <number>`
- `--from <number>`
- `--voice-provider <id>`
- Realtime spec via `--realtime-spec <json>` or `--realtime-spec-file <path>`

System prompt sources (optional):
- `--system-prompt <text>`
- `--system-prompt-file <path>`
- stdin (only when stdin is not a TTY)
