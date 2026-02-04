# Batched HTTP Exporter

Provider-agnostic, retryable, bounded-queue exporter used by modules that send batched events to external platforms via plugin compats (e.g. observability, signals).

## Goals
- Single implementation for:
  - bounded queue + drop policy (oldest dropped)
  - periodic flush + flush-at threshold
  - retry/backoff on failures
  - batch splitting when payload exceeds provider max batch bytes
- Zero provider/platform specifics (those live in `/plugins/**`).

## Architecture
- `index.ts`: Public surface (exports only).
- `internal/exporter.ts`: `BatchedHttpExporter` implementation (queue/flush/retry/shutdown).
- `internal/send-with-size-limit.ts`: Batch build/send + recursive size splitting.
- `internal/runtime.ts`: Shared exporter cache per registry + graceful shutdown hook support.

## Usage
Modules should wrap/extend `BatchedHttpExporter` with a domain-specific interface (e.g. record LLM events vs record signals) and supply:
- a compat implementing `IHttpBatchCompat`
- a provider manifest (`HttpExportProviderManifest`)

