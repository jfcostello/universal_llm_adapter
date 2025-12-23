# Observability Module

The observability module provides optional export of LLM call telemetry to external observability platforms like Langfuse. This enables tracking, debugging, and analyzing LLM usage across your application.

## Features (v1 - LLM Calls Only)

In version 1, observability supports:
- Recording LLM request events (prompt, model, tools, settings)
- Recording LLM response events (content, usage, duration, errors)
- Trace and session correlation
- Non-blocking async export with retry

**Not yet supported:** Embedding calls, vector operations, real-time sessions, tool execution telemetry.

## How to Enable

### Global Configuration (defaults.json)

Enable observability globally by adding to your `defaults.json`:

```json
{
  "observability": {
    "enabled": true,
    "provider": "langfuse",
    "flushAt": 10,
    "flushIntervalMs": 5000,
    "maxQueueSize": 1000,
    "maxAttempts": 3,
    "baseDelayMs": 100,
    "maxDelayMs": 10000,
    "timeoutMs": 30000
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
    provider: 'langfuse',       // Provider ID
    traceId: 'custom-trace-1',  // Optional: custom trace ID
    sessionId: 'session-abc',   // Optional: group related traces
    providerConfig: {           // Optional: provider-specific config
      baseUrl: 'https://custom.langfuse.com'
    },
    // Optional: override queue settings for this call
    flushAt: 5,
    maxAttempts: 5
  }
};
```

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
3. **Shutdown called** - Final flush on graceful shutdown

### Retry and Backoff Policy

Failed exports are retried with exponential backoff and jitter:
- **Max attempts:** `maxAttempts` (default: 3)
- **Base delay:** `baseDelayMs` (default: 100ms)
- **Max delay:** `maxDelayMs` (default: 10000ms)
- **Jitter:** +/- 25% randomness to prevent thundering herd

Formula: `delay = min(baseDelayMs * 2^attempt, maxDelayMs) * (0.5 + random())`

### Shutdown Behavior

When `shutdown()` is called:
1. Timer is stopped (no new automatic flushes)
2. All remaining events in queue are flushed
3. Retries continue until success or max attempts reached
4. After shutdown, new events are rejected with `reason: 'shutdown'`

## Provider Limits

### Langfuse Batch Limits

Langfuse has ingestion limits:
- **Max batch size:** 3.5 MB
- **Max events per batch:** 1000 (configurable server-side)

The Langfuse compat module handles batching within these limits:
- Events are grouped by trace ID into "envelopes"
- Large payloads are handled gracefully (failures are per-envelope, not per-batch)

For optimal performance, keep individual events reasonably sized:
- Avoid extremely long prompts in a single message
- Consider summarizing large tool results

## Configuration Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable observability export |
| `provider` | string | `undefined` | Provider ID (e.g., 'langfuse') |
| `traceId` | string | auto | Trace ID (falls back to correlationId or UUID) |
| `sessionId` | string | undefined | Session ID for grouping traces |
| `providerConfig` | object | undefined | Provider-specific configuration |
| `flushAt` | number | `10` | Flush when queue reaches this size |
| `flushIntervalMs` | number | `5000` | Flush interval in milliseconds |
| `maxQueueSize` | number | `1000` | Max events in queue (oldest dropped if exceeded) |
| `maxAttempts` | number | `3` | Max retry attempts per batch |
| `baseDelayMs` | number | `100` | Base delay for exponential backoff |
| `maxDelayMs` | number | `10000` | Maximum delay cap for backoff |
| `timeoutMs` | number | `30000` | HTTP timeout for export requests |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   LLM Manager   │────▶│   Observability │────▶│   Langfuse      │
│                 │     │   Exporter      │     │   Compat        │
│ recordLLMReq()  │     │                 │     │                 │
│ recordLLMResp() │     │ Queue + Retry   │     │ Build + Send    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │   Langfuse API  │
                                                │   (ingestion)   │
                                                └─────────────────┘
```

## Module Structure

```
modules/observability/
├── index.ts              # Public exports
├── README.md             # This file
└── internal/
    └── observability.ts  # Core implementation
```
