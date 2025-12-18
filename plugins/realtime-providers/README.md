# `plugins/realtime-providers`

Realtime provider manifests (JSON).

These manifests are intentionally **separate** from `plugins/providers/*.json`:

- `plugins/providers/*.json` configures standard request/response LLM calls
- `plugins/realtime-providers/*.json` configures realtime sessions (WebSocket/WebRTC)
- `plugins/realtime-compat/*` contains provider-agnostic realtime compats (`IRealtimeCompat`)

## Manifest shape

```json
{
  "id": "example",
  "compat": "example",
  "endpoint": {
    "urlTemplate": "wss://example.com/realtime?model={model}",
    "headers": {},
    "query": {}
  },
  "webrtc": {
    "endpoint": {
      "urlTemplate": "https://example.com/realtime/calls",
      "headers": {},
      "query": {}
    },
    "clientSecretEndpoint": {
      "urlTemplate": "https://example.com/realtime/client_secrets",
      "headers": {},
      "query": {}
    }
  },
  "metadata": {}
}
```

Notes:

- `compat` maps to `plugins/realtime-compat/<compat>/`.
- `{model}` substitution is supported in `urlTemplate` and `query` values when the compat uses it.
- Environment variable placeholders like `${SOME_KEY}` are supported in string fields.
