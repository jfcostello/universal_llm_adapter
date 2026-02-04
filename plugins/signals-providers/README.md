# Signals Providers

This directory contains **Signals provider manifests** (`*.json`) that can be referenced by `signals.targets[].provider`.

Signals are provider-agnostic events (error/warning/info/debug) that the adapter (or client) can report and export to one or more external targets.

For how to enable Signals and configure targets (defaults/env/per-call), see `modules/signals/README.md`.

## Built-in providers

### `langfuse`

Exports signals to Langfuse as **event observations** via Langfuse's OTLP ingest endpoint.

Required env vars (runtime):
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`

Optional env vars (runtime):
- `LANGFUSE_HOST` (defaults to `https://cloud.langfuse.com`)

### `sentry`

Exports signals to Sentry as **event envelopes** (ingest endpoint derived from a DSN).

Required env vars (runtime):
- `SENTRY_DSN` (or set `signals.targets[].providerConfig.dsn` explicitly)

Optional env vars (live test only):
- `SENTRY_API_KEY` (personal token used to fetch a DSN for the live suite)
- `SENTRY_ORG_SLUG`
- `SENTRY_PROJECT_SLUG`
- `SENTRY_HOST` (defaults to `https://sentry.io`)

