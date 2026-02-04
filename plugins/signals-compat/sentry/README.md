# Sentry Signals Compat (Envelope / Issues)

Exports `SignalEvent` items as Sentry **error events** using the Sentry envelope ingest endpoint so signals show up as **Issues**.

## Mapping

Each `SignalEvent` becomes a Sentry event with:
- `message`: signal message (truncated by `maxAttributeValueBytes`)
- `level`: mapped from `SignalEvent.level` (`debug|info|warning|error`)
- `tags`: includes `llm.adapter.trace_id`, `llm.adapter.generation_id`, and `llm.adapter.code` (when present), plus any `SignalEvent.tags`
- `extra`: includes `correlationId`, `batchId`, `sessionId`, `code`, `stack`, and JSON-serialized `metadata`

## Auth / endpoint

Ingestion uses the **DSN/client key** (not the API token). Configure either:
- `SENTRY_DSN` (recommended), or
- `signals.targets[].providerConfig.dsn` (per-target override)

The compat derives the envelope ingest URL from the DSN:
- `{BASE_URI}/api/{PROJECT_ID}/envelope/`

## Notes

- One signal = one envelope = one Sentry event (dedupe uses a stable `event_id` derived from the exporter event id).
- This compat is intentionally separate from OTLP observability export; Sentry Issues workflows are not OTLP-only.

