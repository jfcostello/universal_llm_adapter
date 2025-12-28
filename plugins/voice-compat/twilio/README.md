# `plugins/voice-compat/twilio`

Twilio voice provider compat consumed by the Voice extension.

This directory is provider-specific by design and may reference provider conventions, payloads, and security behavior.

## Responsibilities

- Build webhook responses (TwiML) that instruct Twilio to connect a Media Stream to the adapter’s Voice extension WS endpoint.
- Bridge the provider WebSocket connection to a core realtime session using the shared `plugins/voice-modules/twilio-media-streams` module.
- Enforce media WS token binding (purpose + identifiers) before bridging.
- Initiate outbound calls.

## Configuration

This compat reads provider defaults from the voice provider manifest (see `plugins/voice-providers/twilio.json`).

Required:
- `defaults.accountSid`
- `defaults.authToken`

Optional:
- `defaults.apiBaseUrl` (default: `https://api.twilio.com`)
- `defaults.outbound.mode` (`twiml` | `url`, default: `twiml`)
- `defaults.outbound.webhookUrl` (required when `mode: "url"`)
- `defaults.outbound.timeoutMs` (default: `15000`)
  - Timeout for the outbound call REST request.
