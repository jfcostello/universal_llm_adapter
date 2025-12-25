# Langfuse Observability Compat

This compat module provides integration with [Langfuse](https://langfuse.com/) for LLM observability and tracing.

## Implementation

This module implements Langfuse's **OpenTelemetry traces ingestion** via **OTLP HTTP/protobuf**:
- Endpoint: `POST /api/public/otel/v1/traces`
- Transport: `Content-Type: application/x-protobuf`
- Data model: OTLP spans with Langfuse attribute keys (e.g. `langfuse.observation.input` / `langfuse.observation.output`)

The compat caches the request event long enough to build a single span when the paired response arrives, so the exported observation includes the full request context and the final response.

## Authentication

Langfuse requires two environment variables:

| Variable | Description |
|----------|-------------|
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (starts with `sk-lf-`) |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (starts with `pk-lf-`) |

Both keys are combined for HTTP Basic authentication.

## Configuration

### Default Endpoint

By default, events are sent to Langfuse Cloud (OTLP traces ingestion):
```
https://cloud.langfuse.com/api/public/otel/v1/traces
```

### Custom Endpoint

For self-hosted Langfuse or custom deployments, set `LANGFUSE_HOST`:

```bash
export LANGFUSE_HOST="https://your-langfuse-instance.com"
```

`LANGFUSE_HOST` should be a **base origin** (no path). The compat appends the OTLP traces path (`/api/public/otel/v1/traces`) automatically.

### Per-Call Endpoint Override (Unsafe)

You can override the endpoint per-call via `providerConfig.baseUrl`, but it is **disabled by default** to avoid SSRF/secret-exfiltration risks in server environments.

To enable it (at your own risk), set:

```bash
export LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE="1"
export LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST="your-langfuse-instance.com"
```

In non-live mode, the override is ignored unless the allowlist is present and non-empty. In live-test mode (`LLM_LIVE=1`), overrides are intentionally permissive to support local failure-path testing.

Then you may specify `baseUrl` in `providerConfig`:

```typescript
observability: {
  enabled: true,
  provider: 'langfuse',
  providerConfig: {
    baseUrl: 'https://your-langfuse-instance.com'
  }
}
```

## Known Limits

### Batch Size
OTLP payloads are byte-sized after protobuf encoding and automatically split into multiple requests when needed.

### Rate Limits
- Langfuse Cloud has rate limits that vary by plan
- Failed requests are retried with exponential backoff

## Event Mapping

LLM events are mapped onto OTLP spans that Langfuse interprets as observations:

| Adapter Event | Langfuse Type | Details |
|---------------|---------------|---------|
| LLM Request | Observation input | Includes messages, tools, settings, request payload |
| LLM Response | Observation output | Includes content, tool calls, usage, errors |

Events with matching `traceId` are grouped into a single trace in Langfuse.

## Trace IDs
Langfuse OTLP traces use **OTLP trace IDs** (32 lowercase hex chars). If you provide a non-OTLP `traceId`, the compat derives a valid OTLP trace ID from it; for deterministic trace lookups by ID, pass a 32-char lowercase hex trace ID yourself.

## Module Structure

```
plugins/observability-compat/langfuse/
├── index.ts              # Public exports
├── README.md             # This file
└── internal/
    └── langfuse.ts       # Compat implementation
```
