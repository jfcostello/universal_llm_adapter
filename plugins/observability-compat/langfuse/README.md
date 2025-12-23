# Langfuse Observability Compat

This compat module provides integration with [Langfuse](https://langfuse.com/) for LLM observability and tracing.

## Implementation

This module implements the **legacy ingestion API** (`POST /api/public/ingestion`):
- Batch ingestion of multiple events per request
- Support for request/response event pairs
- Trace and session grouping via envelope structure

## Authentication

Langfuse requires two environment variables:

| Variable | Description |
|----------|-------------|
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (starts with `sk-lf-`) |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (starts with `pk-lf-`) |

Both keys are combined for HTTP Basic authentication.

## Configuration

### Default Endpoint

By default, events are sent to Langfuse Cloud:
```
https://cloud.langfuse.com/api/public/ingestion
```

### Custom Endpoint

For self-hosted Langfuse or custom deployments, specify `baseUrl` in `providerConfig`:

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
- **Max payload:** 3.5 MB per batch
- **Recommendation:** Keep individual events reasonably sized

### Rate Limits
- Langfuse Cloud has rate limits that vary by plan
- Failed requests are retried with exponential backoff

## Event Mapping

LLM events are mapped to Langfuse's ingestion format:

| Adapter Event | Langfuse Type | Details |
|---------------|---------------|---------|
| LLM Request | `generation-create` | Includes prompt, model, settings |
| LLM Response | `generation-update` | Includes output, usage, duration |

Events with matching `traceId` are grouped into a single trace in Langfuse.

## OpenTelemetry Alternative

Langfuse recommends OpenTelemetry (OTel) for production observability:
- [Langfuse OTel Documentation](https://langfuse.com/docs/integrations/opentelemetry)

OTel support is tracked separately and not yet implemented in this adapter.

## Module Structure

```
plugins/observability-compat/langfuse/
├── index.ts              # Public exports
├── README.md             # This file
└── internal/
    └── langfuse.ts       # Compat implementation
```
