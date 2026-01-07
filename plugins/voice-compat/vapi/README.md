# `plugins/voice-compat/vapi`

Vapi voice provider compat consumed by the Voice extension.

## Scope

- Implements outbound phone calls via Vapi `POST /call`.
- Receives Vapi Server URL webhooks at the adapter’s `POST /voice/webhook?callConfigId=...` endpoint.
- Emits provider-agnostic call events into the Voice extension event hub (SSE via `GET /voice/calls/:callConfigId/events`).

## Configuration

This compat reads provider defaults from `plugins/voice-providers/vapi.json`.

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
