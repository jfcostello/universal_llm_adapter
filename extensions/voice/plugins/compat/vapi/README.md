# `plugins/compat/vapi`

Vapi voice provider compat consumed by the Voice extension.

## Scope

- Implements outbound phone calls via Vapi `POST /call`.
- Receives Vapi Server URL webhooks at the adapter’s `POST /voice/webhook?callConfigId=...` endpoint.
- Emits provider-agnostic call events into the Voice extension event hub (SSE via `GET /voice/calls/:callConfigId/events`).

## Configuration

This compat reads provider defaults from `plugins/providers/vapi.json`.

Required:
- `defaults.apiKey`
- `defaults.webhookAuth` (webhook authentication config; see below)

Optional:
- `defaults.apiBaseUrl` (default: `https://api.vapi.ai`)
- `defaults.controlUrlPollMs` / `defaults.controlUrlMaxWaitMs` (used by `endCall()` to poll for `monitor.controlUrl`)

## Call creation mapping

For `POST /voice/calls` with `voiceProvider: "vapi"`:
- `from` → Vapi `phoneNumberId`
- `to` → Vapi `customer.number`
- `callConfig.systemPrompt` → `assistant.model.messages` (system)
- `callConfig.realtimeSpec.provider` **must** be `"vapi"`
- `callConfig.realtimeSpec.settings.modelProvider` → `assistant.model.provider` (selects the upstream model provider used by Vapi)
- `callConfig.realtimeSpec.model` → `assistant.model.model` (upstream model name, as expected by the selected Vapi model provider)
- `callConfig.realtimeSpec.settings.temperature` → `assistant.model.temperature` (passed through; not clamped)
- `callConfig.realtimeSpec.settings.voiceProvider` → `assistant.voice.provider`
- `callConfig.realtimeSpec.settings.voice` → `assistant.voice.voiceId`
- `callConfig.realtimeSpec.settings.speed` → `assistant.voice.speed`
- `callConfig.realtimeSpec.transcription.*` (or `settings.transcriberProvider` / `settings.transcriberModel`) → `assistant.transcriber.*`

Notes:
- `assistantFirstTurn.delayMs` is not supported; it must be `0` or omitted.
- Only bearer webhook auth is supported for outbound call creation (to set `assistant.server.headers.Authorization`).

## Recording

When `callConfig.recording.enabled=true` and `callConfig.recording.mode="provider"`, this compat configures Vapi per-call recording via:
- `assistant.artifactPlan.recordingEnabled = true`
- `assistant.artifactPlan.recordingFormat`:
  - `callConfig.recording.format = "mp3"` → `"mp3"`
  - `callConfig.recording.format = "wav"` → `"wav;l16"`

On download (`GET /voice/calls/:callConfigId/recording`), the compat resolves the recording URL by fetching the call (`GET /call/{id}`) and selecting:
- Stereo URL when `callConfig.recording.channels = "dual"` and the payload provides a stereo artifact.
- Otherwise the best available combined/mono URL.

## Webhook security

By default, Vapi Server URL webhooks are authenticated using `Authorization: Bearer <token>` matching:
- `defaults.webhookAuth.type = "bearer"`
- `defaults.webhookAuth.token`

Optionally, this compat also supports HMAC signatures for `validateWebhookRequest()` when:
- `defaults.webhookAuth.type = "hmac"`
- `defaults.webhookAuth.secretKey` + `defaults.webhookAuth.algorithm`

Additional HMAC settings supported:
- `signatureHeader` (default: `x-signature`)
- `timestampHeader` (default: `x-timestamp`)
- `signaturePrefix` (default: empty; e.g. `sha256=`)
- `signatureEncoding` (`hex` default; or `base64`)
- `secretIsBase64` (default: `false`)
- `includeTimestamp` (default: `true`)
- `payloadFormat` (default: `{timestamp}.{body}`; supports `{body}`, `{timestamp}`, `{method}`, `{url}`, `{svix-id}`)
- `toleranceSeconds` (default: `300`; `0` disables tolerance checks)

## Tool calling (Server URL webhooks)

This compat supports tool calling via Vapi Server URL webhooks:

- Outbound call creation requests tool-call webhooks by including `tool-calls` and `function-call` in `assistant.serverMessages`.
- On webhook messages with `message.type = "tool-calls"` (preferred) or `message.type = "function-call"` (legacy), tool calls are extracted and routed through the adapter’s standard process routing (via `plugins/processes/*.json`).
- Multiple tool calls are executed with bounded concurrency; `results` preserve the original tool-call order.
- Tool-call webhook responses are always HTTP `200` with a JSON body:
  - `{ "results": [] }` when no tool calls are present
  - `{ "results": [{ "name", "toolCallId", "result" }, ...] }` for successful tool calls
  - `{ "results": [{ "name", "toolCallId", "error" }, ...] }` for failures
- `result` and `error` values are always single-line strings.

Error behavior:
- Invalid tool argument payloads: `error = "invalid_tool_arguments"`
- Tool execution unavailable (missing registry / process routes): `error = "tool_execution_unavailable"`
- Tool invocation failures: `error` is the thrown error message (single-line), or `error = "tool_invocation_failed"` when a usable message cannot be derived.
