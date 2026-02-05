# Observability Module

The observability module provides optional export of LLM call telemetry to external observability platforms (via provider/compat plugins). This enables tracking, debugging, and analyzing LLM usage across your application.

## Features

Observability supports:
- Recording LLM request events (prompt, model, tools, settings)
- Recording LLM response events (content, usage, duration, errors)
- Recording tool execution events (duration, skipped/errors)
- Recording signals (warnings/errors) and trace updates when enabled
- Recording realtime session request/response events per turn (one trace per `commit()`)
- Recording request/response payloads when enabled (`requestPayload` / `rawResponse`)
- Trace and session correlation
- Multi-target export routing (per provider + per event category)
- Non-blocking async export with retry

**Not yet supported:** Embedding calls, vector operations.

## How to Enable

### Global Configuration (`plugins/configs/defaults.json`)

Enable observability globally by adding to your `plugins/configs/defaults.json`:

```json
{
  "observability": {
    "enabled": true,
    "provider": "your-observability-provider-id"
  }
}
```

To reduce capture from the shipped defaults:

```json
{
  "observability": {
    "enabled": true,
    "provider": "your-observability-provider-id",
    "captureMessages": "text",
    "captureToolArgs": false,
    "captureRequestPayload": false,
    "captureRawResponse": false
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
    // Optional: capture controls (override defaults)
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

### Multi-Target Configuration (`targets`)

To export to multiple providers, use `observability.targets` (either globally in defaults or per-call):

```json
{
  "observability": {
    "enabled": true,
    "targets": [
      { "provider": "langfuse", "export": { "signals": false } },
      { "provider": "sentry", "export": { "traces": false, "tools": false, "traceUpdates": false } }
    ]
  }
}
```

Each target supports:
- `provider`: observability provider id (`plugins/observability-providers/*.json`)
- `providerConfig`: provider-specific settings passed through to the compat
- `export`: per-category routing flags (`traces`, `tools`, `signals`, `traceUpdates`)
- Optional per-target queue tuning overrides (`flushAt`, `timeoutMs`, etc.)

## Client Telemetry Submission

In addition to automatic capture during LLM calls and realtime sessions, the adapter supports **client-submitted telemetry**:

- CLI: `llm-adapter telemetry`
- Server: `POST /telemetry`

These submissions are validated and then recorded into the same observability exporter queue (with the same routing semantics).

### Signal

```json
{
  "type": "signal",
  "traceId": "trace-123",
  "level": "error",
  "message": "Something went wrong"
}
```

### Trace update

```json
{
  "type": "trace_update",
  "traceId": "trace-123",
  "name": "checkout-flow",
  "tags": ["web", "prod"]
}
```

### Per-submission override (optional)

Include an `observability` object to override routing/settings for this submission only (useful when observability is disabled globally):

```json
{
  "type": "signal",
  "traceId": "trace-123",
  "level": "warning",
  "message": "Send this to a specific target",
  "observability": {
    "enabled": true,
    "traceId": "trace-123",
    "flushAt": 1,
    "targets": [
      { "provider": "sentry", "export": { "signals": true } }
    ]
  }
}
```

## Realtime Sessions

Realtime observability is implemented in the provider-agnostic realtime session controller (`modules/realtime`).

When `spec.observability.enabled=true`, the controller records:
- `LLM_REQUEST` on every `commit()` (includes accumulated conversation messages up to that turn)
- `LLM_RESPONSE` when the assistant produces a final transcript/text event (or a best-effort error response if the session closes mid-turn)

Trace/session ids:
- `baseTraceId`: resolved once for the session (`spec.observability.traceId` → `metadata.correlationId` → UUID)
- Per-turn `traceId`: `baseTraceId` for turn 1, then `${baseTraceId}:${turn}` for turn N
- `sessionId`: defaults to `metadata.correlationId` for realtime sessions (can be overridden via `spec.observability.sessionId`)

Tool calls:
- When tool calling is enabled, tool invocations for a pending turn are attached to the next `LLM_RESPONSE` event.
- `captureToolArgs` controls whether arguments are included.

## IDs and Metadata

In addition to `spec.observability.*`, the adapter uses `spec.metadata` for correlation and grouping:

- `spec.metadata.correlationId`: stable per-request identifier (some providers use this as a trace name/display label).
- `spec.metadata.batchId`: optional per-request batch identifier; when `spec.observability.sessionId` is not set, this is used as the default session/grouping ID for observability.
- `spec.observability.sessionId`: stable per-session identifier to group related traces (overrides `spec.metadata.batchId`).
- `spec.metadata.tags`: optional array of strings forwarded to observability providers that support tagging.

The adapter also forwards token breakdown details (e.g., input/output/total, cached/reasoning/audio tokens) when they are provided by the underlying provider or can be derived from the response.

## Capture Controls (Safety + Performance)

Observability export is disabled by default. When enabled, **shipped defaults capture full messages and payloads** for maximum debuggability, and can be dialed down to reduce latency/CPU/memory and the risk of exporting sensitive content.

- `captureMessages`:
  - `none`: do not export prompt/response bodies
  - `text`: export only text content parts (excludes documents, images, tool result payloads)
  - `full` (default in shipped defaults): export full structured message/content payloads
- `captureToolArgs` (default `true` in shipped defaults): export tool-call arguments/metadata
- `captureRequestPayload` (default `true` in shipped defaults): export final provider request payload
- `captureRawResponse` (default `true` in shipped defaults): export raw provider response payloads (when available)
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
- Drop warnings are **throttled** to avoid log spam under sustained overload; warnings include the number of drops since the last warning
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

### Metrics and Duration Semantics

- `durationMs` in response events is end-to-end elapsed time in milliseconds (includes internal retries/backoff). It is measured using a monotonic clock (not affected by wall-clock adjustments).
- Exporter metrics:
  - `enqueuedTotal` / `droppedTotal` count events.
  - `sentCount` / `failedCount` count batch send attempts/outcomes (not individual events).

### Shutdown Behavior

Observability exporters are **process-level** and may be shared across many LLM calls (especially in server mode).

When observability shutdown is triggered (CLI completion / server shutdown):
1. Timer is stopped (no new automatic flushes)
2. All remaining events in queue are flushed
3. Retries continue until success or max attempts reached (unless the shutdown cap is hit)
4. If `shutdownTimeoutMs > 0` (default `5000ms`), shutdown waiting is bounded; if the timeout is hit, in-flight exports are aborted best-effort, remaining queued events are dropped, and a summary is logged
   - Set `shutdownTimeoutMs = 0` to disable the shutdown cap (wait unbounded)
5. After shutdown, new events are rejected with `reason: 'shutdown'`

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
| `provider` | string | `'langfuse'` | Provider ID |
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
| `shutdownTimeoutMs` | number | `5000` | Max time to wait for exporter shutdown during process exit (set `0` to disable cap) |
| `maxAttributeValueBytes` | number | `16384` | Max UTF-8 bytes for any exported attribute string value |
| `captureMessages` | `'none' \| 'text' \| 'full'` | `'full'` | Capture prompt/response content bodies |
| `captureToolArgs` | boolean | `true` | Capture tool-call args/metadata |
| `captureRequestPayload` | boolean | `true` | Capture final provider request payload |
| `captureRawResponse` | boolean | `true` | Capture raw provider response payloads |
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
    ├── compat-helpers.ts
    ├── exporter/         # Core queue + exporter + runtime cache
    │   ├── README.md
    │   ├── index.ts
    │   └── internal/
    │       ├── config.ts
    │       ├── create-deps.ts
    │       ├── exporter.ts
    │       ├── multi-exporter.ts
    │       ├── runtime.ts
    │       ├── send-with-size-limit.ts
    │       └── types.ts
    ├── observability.ts  # Re-export: exporter public surface
    ├── otlp/             # OTLP HTTP/protobuf encoding + client helpers
    │   ├── chunk-and-encode.ts
    │   ├── client.ts
    │   ├── encode-worker.ts
    │   ├── encode.ts
    │   ├── ids.ts
    │   ├── spans.ts
    │   ├── time.ts
    │   └── types.ts
    ├── runtime.ts
    └── telemetry-submit.ts
```
