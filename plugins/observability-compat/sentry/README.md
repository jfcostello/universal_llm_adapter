# Sentry Observability Compat

This compat module provides optional observability export to Sentry:

- **Signals / errors** export via **Sentry Envelopes** (DSN-based ingestion).
- **Traces / tools** export via **Sentry OTLP traces** ingestion (optional; disabled by default).

## Authentication

Set `SENTRY_DSN` in your environment (or `.env`):

```bash
export SENTRY_DSN="https://<public_key>@<host>/<project_id>"
```

Self-hosted Sentry may include a path prefix:

```bash
export SENTRY_DSN="https://<public_key>@sentry.example.com/sentry/<project_id>"
```

## Enabling

Sentry is configured via the standard observability spec.

### Multi-target (recommended)

Export **only signals** (errors/warnings) to Sentry:

```json
{
  "observability": {
    "enabled": true,
    "targets": [
      {
        "provider": "sentry",
        "export": { "signals": true, "traces": false, "tools": false, "traceUpdates": false }
      }
    ]
  }
}
```

### Optional OTLP traces/tools

OTLP export is disabled by default. To enable traces/tools export, set:

```json
{
  "observability": {
    "enabled": true,
    "targets": [
      {
        "provider": "sentry",
        "providerConfig": { "enableOtlp": true },
        "export": { "signals": true, "traces": true, "tools": true, "traceUpdates": true }
      }
    ]
  }
}
```

### Optional tool result envelopes (OTLP disabled)

If you want successful tool results to be queryable as Sentry events **without** OTLP enabled, set:

```json
{
  "observability": {
    "enabled": true,
    "targets": [
      {
        "provider": "sentry",
        "providerConfig": { "exportToolResultsAsSignals": true },
        "export": { "signals": true, "tools": true }
      }
    ]
  }
}
```

Notes:
- This only applies when `providerConfig.enableOtlp` is **not** enabled.
- Only successful tool executions are exported this way (tool failures are already emitted as signals by core tool-loop handling).

### Trace update behavior

`trace_update` events are treated as trace-context mutations (name/tags/session fields) and do **not** emit standalone Sentry envelopes or spans by themselves.
The updated context is applied to subsequent Sentry exports that share the same trace/generation keys.

### Generation parent linkage

For OTLP generation spans:
- Request/response events for one coordinated request reuse the same `generationId`.
- If `parentGenerationId` is present and differs from `generationId`, the generation span is attached under that parent generation span.
- If no parent is provided, generation spans are emitted without generation-parent linkage.

## Optional Provider Config

These settings live under `observability.targets[].providerConfig` for the Sentry target.

### Envelope send tuning (signals/errors)

- `envelopeConcurrency` (number|string, default `2`, min `1`, max `10`) — send multiple envelopes concurrently to reduce flush wall time under bursts.
- `Retry-After` and `X-Sentry-Rate-Limits` pacing is honored whenever headers are present (including `200` responses).
- `429` envelope outcomes are reported as non-retryable and are not requeued by exporter retry loops.
- `includeResponseBodyOnError` (boolean, default `false`) — when true, non-2xx envelope outcomes include a truncated response body excerpt to aid debugging.
  - If the response body is JSON, the excerpt is redacted for common credential key names.
  - Use with care: response bodies may contain sensitive data depending on upstream behavior.
- `errorResponseBodyMaxBytes` (number|string, default `1024`, min `0`, max `65536`) — maximum UTF-8 bytes included when `includeResponseBodyOnError` is enabled (`0` disables body capture).

## Module Structure

```
plugins/observability-compat/sentry/
├── index.ts
├── README.md
└── internal/
    ├── sentry.ts
    ├── sentry-send.ts
    └── sentry-helpers.ts
```
