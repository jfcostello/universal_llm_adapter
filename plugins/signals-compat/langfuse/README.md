# Langfuse Signals Compat (OTLP)

Exports `SignalEvent` items as Langfuse **event observations** via the OTLP traces ingest endpoint.

## Mapping

Each `SignalEvent` becomes an OTLP span with:
- `langfuse.observation.type = "event"`
- `langfuse.observation.level` mapped from `SignalEvent.level`:
  - `debug -> DEBUG`
  - `info -> DEFAULT`
  - `warning -> WARNING`
  - `error -> ERROR`
- `langfuse.observation.status_message` set to the signal message

Parenting:
- `traceId` maps to OTLP `traceId`
- `generationId` maps to OTLP `parentSpanId` so the event is attached to the LLM attempt span

## Auth

Uses basic auth with:
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`

## Endpoint

Default ingest URL template is:
- `${LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/otel/v1/traces`

