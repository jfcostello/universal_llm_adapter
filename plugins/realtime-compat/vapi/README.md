# `plugins/realtime-compat/vapi`

Vapi realtime compat (WebSocket transport).

## Configuration

Required env vars:
- `VAPI_API_KEY`

Provider manifest:
- `plugins/realtime-providers/vapi.json`

## Notes

- This compat creates calls via `POST https://api.vapi.ai/call` with `transport.provider: "vapi.websocket"` and then connects to the returned `transport.websocketCallUrl`.
- Audio is sent/received as binary frames over the WS.
- Tool calling: Vapi’s primary supported tool-result loop is server-webhook based. This compat implements a best-effort local tool loop by injecting tool output back into the call context.

