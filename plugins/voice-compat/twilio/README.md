# `plugins/voice-compat/twilio`

Twilio voice provider compat consumed by the Voice extension.

This directory is provider-specific by design and may reference provider conventions, payloads, and security behavior.

## Responsibilities

- Build webhook responses (TwiML) that instruct Twilio to connect a Media Stream to the adapter’s Voice extension WS endpoint.
- Bridge the provider WebSocket connection to a core realtime session using the shared `plugins/voice-modules/twilio-media-streams` module.
- Initiate outbound calls (implemented in a separate issue).

