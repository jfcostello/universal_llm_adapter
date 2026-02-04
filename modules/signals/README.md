# Signals

Provider-agnostic error/warning/info reporting that can be exported to external platforms via plugin providers/compats.

This module is designed for:
- Adapter-emitted signals (e.g., internal errors)
- Client-emitted signals (e.g., a client wants to attach an error to a specific LLM attempt)

Signals are queued and exported in the background via a bounded, retryable batch exporter. Configuration supports **multi-target fanout** so multiple providers can be enabled simultaneously.

## Configuration

Signals configuration comes from:
1) `plugins/configs/defaults.json` (`signals.*`)
2) Environment variables (`LLM_ADAPTER_SIGNALS_*`)
3) Per-call overrides passed to `createSignalsDeps(registry, spec)`

Precedence: per-call `spec` > env vars > defaults.

### Defaults.json

`signals.enabled` controls whether export is enabled.

`signals.targets` is an array of objects:
- `provider` (string): provider id from `plugins/signals-providers/*.json`
- `providerConfig` (object, optional): passed through to the compat as opaque config

Queue/export tuning:
- `flushAt`, `flushIntervalMs`, `maxQueueSize`
- `maxAttempts`, `baseDelayMs`, `maxDelayMs`
- `timeoutMs`, `shutdownTimeoutMs`
- `maxAttributeValueBytes`

### Env vars

- `LLM_ADAPTER_SIGNALS_ENABLED`: `1|0|true|false|yes|no`
- `LLM_ADAPTER_SIGNALS_TARGETS`:
  - CSV: `providerA,providerB`
  - JSON: `[{"provider":"providerA"},{"provider":"providerB","providerConfig":{...}}]`

## Reporting a signal

Signals must be tied to a specific attempt:
- `traceId` (string)
- `generationId` (string)

Example:
```ts
const deps = await createSignalsDeps(registry, {
  enabled: true,
  targets: [{ provider: 'your-provider-id' }]
});

deps.getExporter().recordSignal({
  traceId: 'trace-123',
  generationId: 'gen-456',
  timestampMs: Date.now(),
  level: 'error',
  message: 'Something went wrong',
  metadata: { extra: 'context' }
});
```

## Redaction

`metadata` is passed through adapter redaction (`redactJsonCredentials`) before export.
Provider compats should still enforce their own truncation and size limits.

