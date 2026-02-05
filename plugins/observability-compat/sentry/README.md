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
