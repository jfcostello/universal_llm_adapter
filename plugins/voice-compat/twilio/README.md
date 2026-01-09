# `plugins/voice-compat/twilio`

Twilio voice provider compat consumed by the Voice extension.

This directory is provider-specific by design and may reference provider conventions, payloads, and security behavior.

## Responsibilities

- Build webhook responses (TwiML) that instruct Twilio to connect a Media Stream to the adapter’s Voice extension WS endpoint.
- Bridge the provider WebSocket connection to a core realtime session using the shared `plugins/voice-modules/twilio-media-streams` module.
- Enforce media WS token binding (purpose + identifiers) before bridging.
- Initiate outbound calls.

## Media WS token delivery

The voice extension requires a signed token for `WS /voice/media`.

Twilio Media Streams may drop query parameters on the WebSocket URL. This compat passes the token via TwiML `<Parameter>` (name: `voiceMediaToken`) attached to the `<Stream>` element.

This requires token-in-message support to be enabled on the voice extension (`server.extensions.voice.mediaWs.tokenFromMessageTimeoutMs > 0`, default: `5000`).

For safety, `voiceMediaToken` is treated as a reserved custom parameter and is stripped before call metadata is surfaced to the realtime session.

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
- `defaults.mediaStreams.outboundBufferMaxFrames` (default: `15000`)
  - Max pending outbound audio frames buffered in the media bridge (used to absorb bursty realtime generation vs real-time playback).

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
- `callConfig.timeouts.firstTurnGraceMs` (optional, non-negative):
  - forwarded to the Twilio media-streams bridge as `limits.firstTurnGraceMs` (see `plugins/voice-modules/twilio-media-streams/README.md`).
  - When omitted, this compat defaults to `500` only when `callConfig.realtimeSpec.provider === "grok"`; otherwise it is disabled.
- `callConfig.timeouts.silenceAssistantAudioEndFallbackMs` (optional):
  - when `assistantFirstTurn.enabled=true`, treats assistant audio as ended this many milliseconds after the first `assistant_audio.chunk` if `assistant_audio.end` is never emitted.
  - default: `min(2000, max(500, silenceTimeoutMs))`.
- `callConfig.timeouts.silenceAssistantAudioStartFallbackMs` (optional):
  - when `assistantFirstTurn.enabled=true`, treats assistant audio as ended this many milliseconds after the first-turn `commit()` if no `assistant_audio.*` events are ever emitted.
  - default: `max(3000, silenceTimeoutMs)`.

### Media bridge buffering

- `callConfig.providerConfig.mediaStreams.outboundBufferMaxFrames` (optional, positive integer):
  - overrides `defaults.mediaStreams.outboundBufferMaxFrames` for this call.

When `assistantFirstTurn.enabled=true`, the silence timeout is armed after the first `assistant_audio.end` event (or after the applicable fallback window if `assistant_audio.end` is never emitted).

You can also terminate a call via `POST /voice/calls/:callConfigId/end` (server auth required).

### Graceful call end (playback drained)

This compat emits provider-agnostic call events designed to support graceful hangup:

- `voice.assistant_audio.started` / `voice.assistant_audio.ended`
  - derived from realtime session events (`assistant_audio.chunk` / `assistant_audio.end`)
  - `assistant_audio.ended` may be synthesized by the adapter’s fallback timers when first-turn audio boundary events are missing (see the timeout notes above).
- `voice.playback.drained`
  - emitted when Twilio acknowledges a **drain mark** (sent after `assistant_audio.end` via the shared `twilio-media-streams` bridge).
  - suitable for “all pending outbound audio has been played” signals.

These events are visible to clients via `GET /voice/calls/:callConfigId/events` (SSE) and can be used with `POST /voice/calls/:callConfigId/end`:

- `mode=after_assistant_audio`: waits for `voice.assistant_audio.ended`
- `mode=after_playback`: waits for `voice.playback.drained` (recommended to avoid cutting off TTS mid-sentence)

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

### Provider call log capture

After a call ends, this compat attempts to fetch and persist Twilio-side call artifacts under:
- `logs/voice/twilio/call-<CallSid>-<timestamp>/`

This is best-effort and non-blocking; capture runs asynchronously and does not delay media WS cleanup.

Artifacts are best-effort (permissions vary by account/project). When available, the compat writes:
- `call.json` (call resource)
- `events.json` (call events; paginated)
- `recordings.json` (recordings list; paginated)
- `debugger-events.json` (debugger events; may be unavailable / 403)

Retention is applied using the same max-files / max-age policy as other voice logs.

Controls:
- `LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_PAGES` (default: `25`)
  - Hard cap for paginated resources (`events`, `recordings`, `debugger-events`).
- `LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_RETRIES` (default: `2`)
- `LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_BASE_DELAY_MS` (default: `250`)
- `LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_MAX_DELAY_MS` (default: `2000`)
  - Best-effort retry/backoff applies to `429` and `5xx` responses.
