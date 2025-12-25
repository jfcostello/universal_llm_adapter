# Observability Module

The observability module provides optional export of LLM call telemetry to external observability platforms (via provider/compat plugins). This enables tracking, debugging, and analyzing LLM usage across your application.

## Features (v1 - LLM Calls Only)

In version 1, observability supports:
- Recording LLM request events (prompt, model, tools, settings)
- Recording LLM response events (content, usage, duration, errors)
- Recording request/response payloads when enabled (`requestPayload` / `rawResponse`)
- Trace and session correlation
- Non-blocking async export with retry

**Not yet supported:** Embedding calls, vector operations, real-time sessions, tool execution telemetry.

## How to Enable

### Global Configuration (`plugins/configs/defaults.json`)

Enable observability globally by adding to your `plugins/configs/defaults.json`:

```json
{
  "observability": {
    "enabled": true,
    "provider": "your-observability-provider-id",
    "flushAt": 10,
    "flushIntervalMs": 5000,
    "maxQueueSize": 1000,
    "maxAttempts": 3,
    "baseDelayMs": 250,
    "maxDelayMs": 30000,
    "timeoutMs": 10000,
    "maxAttributeValueBytes": 16384,
    "captureMessages": "none",
    "captureToolArgs": false,
    "captureRequestPayload": false,
    "captureRawResponse": false,
    "sampleRate": 1,
    "maxInputTextBytes": 4096,
    "maxOutputTextBytes": 4096,
    "maxJsonBytes": 8192
  }
}
```

### Per-Call Override

Override global settings for a specific call using `spec.observability`:

```typescript
const spec = {
  messages: [...],
  llmPriority: [...],
  settings: {...},
  observability: {
    enabled: true,              // Enable for this call
    provider: 'your-provider',  // Provider ID
    traceId: 'custom-trace-1',  // Optional: custom trace ID
    sessionId: 'session-abc',   // Optional: group related traces
    providerConfig: {           // Optional: provider-specific config (provider-defined shape)
      // ...
    },
    // Optional: override queue settings for this call
    flushAt: 5,
    maxAttempts: 5,
    // Optional: truncation budget for exported attribute strings (UTF-8 bytes)
    maxAttributeValueBytes: 8192,
    // Optional: capture controls (safety/performance)
    captureMessages: 'text',
    captureToolArgs: false,
    captureRequestPayload: false,
    captureRawResponse: false,
    // Optional: sampling and budgets
    sampleRate: 1,
    maxInputTextBytes: 4096,
    maxOutputTextBytes: 4096,
    maxJsonBytes: 8192
  }
};
```

## IDs and Metadata

In addition to `spec.observability.*`, the adapter uses `spec.metadata` for correlation and grouping:

- `spec.metadata.correlationId`: stable per-request identifier (some providers use this as a trace name/display label).
- `spec.observability.sessionId`: stable per-session identifier to group related traces (in live tests this is typically the run-wide `batchId`).
- `spec.metadata.tags`: optional array of strings forwarded to observability providers that support tagging.

The adapter also forwards token breakdown details (e.g., input/output/total, cached/reasoning/audio tokens) when they are provided by the underlying provider or can be derived from the response.

## Capture Controls (Safety + Performance)

Observability export is enabled explicitly, but **payload capture is disabled by default** to reduce latency, CPU, memory, and the risk of exporting sensitive content.

- `captureMessages`:
  - `none` (default): do not export prompt/response bodies
  - `text`: export only text content parts (excludes documents, images, tool result payloads)
  - `full`: export full structured message/content payloads
- `captureToolArgs` (default `false`): export tool-call arguments/metadata
- `captureRequestPayload` (default `false`): export final provider request payload
- `captureRawResponse` (default `false`): export raw provider response payloads (when available)
- `sampleRate` (default `1`): sampling rate (0..1). When < 1, calls may be skipped entirely.

Budgets:
- `maxInputTextBytes` / `maxOutputTextBytes`: caps for aggregated prompt/response text fields
- `maxJsonBytes`: cap for JSON-like exported fields (e.g., structured inputs/outputs)
- `maxAttributeValueBytes`: per-attribute cap used by compats to avoid oversized exports

## Queue Semantics

### Non-Blocking Design

Observability is designed to **never block or slow down** LLM operations:
- Events are queued asynchronously
- Recording failures are logged but never thrown
- Main LLM execution path is unaffected by observability errors

### Bounded Queue with Drop Policy

The event queue has a maximum size (`maxQueueSize`, default 1000):
- When the queue is full, the **oldest events are dropped**
- A warning is logged for each dropped event
- This prevents unbounded memory growth during high-volume bursts

### Flush Triggers

Events are flushed (exported) when:
1. **Queue threshold reached** - When `flushAt` events accumulate (default: 10)
2. **Timer fires** - Every `flushIntervalMs` milliseconds (default: 5000ms)
3. **Process shutdown** - Final flush on CLI completion / server shutdown

### Retry and Backoff Policy

Failed exports are retried with exponential backoff and jitter:
- **Max attempts:** `maxAttempts` (default: 3)
- **Base delay:** `baseDelayMs` (default: 250ms)
- **Max delay:** `maxDelayMs` (default: 30000ms)
- **Jitter:** +/- 25% randomness to prevent thundering herd

Formula: `delay = min(baseDelayMs * 2^attempt, maxDelayMs) * (0.75 + random() * 0.5)`

### Shutdown Behavior

Observability exporters are **process-level** and may be shared across many LLM calls (especially in server mode).

When observability shutdown is triggered (CLI completion / server shutdown):
1. Timer is stopped (no new automatic flushes)
2. All remaining events in queue are flushed
3. Retries continue until success or max attempts reached
4. After shutdown, new events are rejected with `reason: 'shutdown'`

## Provider Limits

### OTLP Batch Limits

When using OTLP HTTP/protobuf ingestion, payloads are chunked by encoded size:
- **Max batch size:** 3,670,016 bytes (~3.5 MiB) by default
- Providers may override this via `plugins/observability-providers/<id>.json` (`limits.maxBatchBytes`)

Compat modules are responsible for mapping queued events into provider-specific payloads/envelopes. The core exporter uses per-envelope outcomes to decide what to retry vs drop.

For optimal performance, keep individual events reasonably sized:
- Avoid extremely long prompts in a single message
- Consider summarizing large tool results

### OTLP Worker Thread (Optional)

To reduce event-loop CPU impact at high concurrency, OTLP chunking/encoding can be offloaded to a worker thread.

Env var:
- `LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER=1` force-enable worker encoding
- `LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER=0` force-disable worker encoding
- unset: enabled by default only for compiled JS bundles (and disabled by default in Jest)

## Configuration Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable observability export |
| `provider` | string | `undefined` | Provider ID |
| `traceId` | string | auto | Trace ID (falls back to correlationId or UUID) |
| `sessionId` | string | undefined | Session ID for grouping traces |
| `providerConfig` | object | undefined | Provider-specific configuration |
| `flushAt` | number | `10` | Flush when queue reaches this size |
| `flushIntervalMs` | number | `5000` | Flush interval in milliseconds |
| `maxQueueSize` | number | `1000` | Max events in queue (oldest dropped if exceeded) |
| `maxAttempts` | number | `3` | Max retry attempts per batch |
| `baseDelayMs` | number | `250` | Base delay for exponential backoff |
| `maxDelayMs` | number | `30000` | Maximum delay cap for backoff |
| `timeoutMs` | number | `10000` | HTTP timeout for export requests |
| `maxAttributeValueBytes` | number | `16384` | Max UTF-8 bytes for any exported attribute string value |
| `captureMessages` | `'none' \| 'text' \| 'full'` | `'none'` | Capture prompt/response content bodies |
| `captureToolArgs` | boolean | `false` | Capture tool-call args/metadata |
| `captureRequestPayload` | boolean | `false` | Capture final provider request payload |
| `captureRawResponse` | boolean | `false` | Capture raw provider response payloads |
| `sampleRate` | number | `1` | Sampling rate (0..1). When < 1, calls may be skipped |
| `maxInputTextBytes` | number | `4096` | Max UTF-8 bytes for aggregated input text fields |
| `maxOutputTextBytes` | number | `4096` | Max UTF-8 bytes for aggregated output text fields |
| `maxJsonBytes` | number | `8192` | Max UTF-8 bytes for JSON-like exported fields |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   LLM Manager   │────▶│   Observability │────▶│  Provider Compat │
│                 │     │   Exporter      │     │                 │
│ recordLLMReq()  │     │                 │     │ Build + Send    │
│ recordLLMResp() │     │ Queue + Retry   │     └─────────────────┘
└─────────────────┘     └─────────────────┘              │
                                                         ▼
                                                ┌─────────────────┐
                                                │ Provider Ingest │
                                                │ (e.g., OTLP)    │
                                                └─────────────────┘
```

## Module Structure

```
modules/observability/
├── index.ts              # Public exports
├── README.md             # This file
└── internal/
    ├── observability.ts  # Core queue + exporter + runtime
    └── otlp/             # OTLP HTTP/protobuf encoding + client helpers
        ├── client.ts
        ├── encode.ts
        ├── ids.ts
        ├── spans.ts
        ├── time.ts
        └── types.ts
```
