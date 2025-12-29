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

## Supported voice extension features

This compat consumes additional call config fields created by the voice extension (`POST /voice/calls`) and applies them to Twilio.

### Assistant speaks first (dynamic greeting)

When `callConfig.assistantFirstTurn.enabled=true` and `assistantFirstTurn.prompt` is provided, the bridge will:
- wait for the realtime session `ready`
- send the configured prompt as a text turn
- `commit()` to trigger immediate assistant audio output

This is **dynamic** (LLM-generated) and does not use pre-recorded audio. The prompt text is never logged.

### Call control + timeouts

- `callConfig.timeouts.callTimeoutMs`:
  - applied to the outbound call via Twilio `TimeLimit` (seconds).
- `callConfig.timeouts.silenceTimeoutMs`:
  - enforced adapter-side during the media bridge (hang up after no user input for the configured duration).
- `callConfig.timeouts.silenceAssistantAudioEndFallbackMs` (optional):
  - when `assistantFirstTurn.enabled=true`, treats assistant audio as ended this many milliseconds after the first `assistant_audio.chunk` if `assistant_audio.end` is never emitted.
  - default: `min(2000, max(500, silenceTimeoutMs))`.
- `callConfig.timeouts.silenceAssistantAudioStartFallbackMs` (optional):
  - when `assistantFirstTurn.enabled=true`, treats assistant audio as ended this many milliseconds after the first-turn `commit()` if no `assistant_audio.*` events are ever emitted.
  - default: `max(3000, silenceTimeoutMs)`.

When `assistantFirstTurn.enabled=true`, the silence timeout is armed after the first `assistant_audio.end` event (or after the applicable fallback window if `assistant_audio.end` is never emitted).

You can also terminate a call via `POST /voice/calls/:callConfigId/end` (server auth required).

### Provider-side recording + download

When `callConfig.recording.enabled=true` and `callConfig.recording.mode="provider"`:
- outbound calls set `Record=true` and `RecordingChannels`
- the provider can be configured to post recording completion callbacks to `/voice/webhook/recording`

Once the recording callback has been received and stored on the call config, the server can proxy-download the artifact via:
- `GET /voice/calls/:callConfigId/recording` (server auth required)

The download request is authenticated upstream using the configured `accountSid` + `authToken`.

To harden against SSRF, the recording URL received from the webhook is validated before being stored:
- `https:` only
- must match the origin of `defaults.apiBaseUrl` (default: `https://api.twilio.com`)
