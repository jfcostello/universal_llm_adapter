# `modules/server`

Transport-only HTTP/SSE server for exposing the coordinator over the network.

## Purpose
This module provides a minimal, high-performance Node `http` server that accepts
the same `LLMCallSpec` JSON used by the CLI and returns identical responses or
stream events.

It contains **no** LLM logic; it is a thin transport adapter around the existing
coordinator lifecycle helpers.

## Module Layout
- `modules/server/index.ts` — public API.
- `modules/server/internal/handler.ts` — internal request handler orchestrator.
- `modules/server/internal/transport/*` — body parsing, spec validation, error mapping, concurrency/queueing.
- `modules/server/internal/security/*` — auth, rate limiting, CORS, security headers.
- `modules/server/internal/streaming/*` — SSE helpers.

Only `index.ts` should be imported by other code.

Legacy entrypoints:
- `utils/server/index.ts` forwards to this module during the migration.

## Public API

### `createServer(options?): Promise<RunningServer>`

Starts an HTTP server.

Options:
- `host` (string, default `"127.0.0.1"`)
- `port` (number, default `0` for ephemeral)
- `pluginsPath` (string, default `"./plugins"`)
- `batchId` (string, optional)
- `closeLoggerAfterRequest` (boolean, default `false`)
- `maxRequestBytes` (number, default `26214400` / 25MB) — maximum JSON body size including any embedded base64.
- `bodyReadTimeoutMs` (number, default `10000`) — timeout while reading the request body.
- `requestTimeoutMs` (number, default `0` = disabled) — total wall‑clock timeout for `/run`, `/vector/run`, `/vector/embeddings/run`, and `/stream`.
- `streamIdleTimeoutMs` (number, default `60000`) — max idle gap between SSE events before closing.
- `maxConcurrentRequests` (number, default `128`) — concurrent `/run` executions.
- `maxConcurrentStreams` (number, default `32`) — concurrent `/stream` executions.
- `maxQueueSize` (number, default `1000`) — queued requests per limiter when saturated.
- `queueTimeoutMs` (number, default `30000`) — max time a request may wait in the queue.
- `maxConcurrentVectorRequests` (number, default `128`) — concurrent `/vector/run` executions.
- `maxConcurrentVectorStreams` (number, default `32`) — concurrent `/vector/stream` executions.
- `vectorMaxQueueSize` (number, default `1000`) — queue size for vector limiters when saturated.
- `vectorQueueTimeoutMs` (number, default `30000`) — max time a vector request may wait in the queue.
- `maxConcurrentEmbeddingRequests` (number, default `128`) — concurrent `/vector/embeddings/run` executions.
- `embeddingMaxQueueSize` (number, default `1000`) — queue size for embedding limiter when saturated.
- `embeddingQueueTimeoutMs` (number, default `30000`) — max time an embedding request may wait in the queue.
- `auth` (object, default disabled) — optional request auth.
  - `enabled` (boolean)
  - `allowBearer` (boolean, default `true`) — accept `Authorization: Bearer <token>`.
  - `allowApiKeyHeader` (boolean, default `true`) — accept API key header.
  - `headerName` (string, default `"x-api-key"`)
  - `apiKeys` (string[] or comma‑separated string, **env only**) — active raw keys for rotation.
  - `hashedKeys` (string[] or comma‑separated string) — optional `sha256:<hex>` digests.
  - `realm` (string, default `"llm-adapter"`) — realm for 401 challenges.
- `rateLimit` (object, default disabled) — in‑memory token‑bucket limiter per client.
  - `enabled` (boolean)
  - `requestsPerMinute` (number, default `120`)
  - `burst` (number, default `30`)
  - `trustProxyHeaders` (boolean, default `false`) — if true, use `x-forwarded-for` for IP.
- `cors` (object, default disabled) — CORS handling and preflight.
  - `enabled` (boolean)
  - `allowedOrigins` (string[] or `"*"`)
  - `allowedHeaders` (string[], default `["content-type","authorization","x-api-key"]`)
  - `allowCredentials` (boolean, default `false`)
- `securityHeadersEnabled` (boolean, default `true`) — adds safe browser/proxy hardening headers.
- `authorize` (function, optional) — pluggable auth hook; returning false rejects with 403.
- `deps` (partial `ServerDependencies`) — dependency injection for tests/embedding.
- `registry` (`PluginRegistryLike`) — optional pre-built registry.

All of the hardening defaults live under `server` in `plugins/configs/defaults.json`
and can be overridden globally there or per‑server via the options above.

Returns:
- `url` — base URL.
- `server` — underlying Node server.
- `close()` — shuts down server and closes loggers.

### `createServerHandlerWithDefaults(options)`

Creates a request handler when embedding the server into an existing Node HTTP
server. Requires `options.registry` to be provided.
Accepts the same options and defaults as `createServer`.

## Endpoints

### `POST /run`
- Body: `LLMCallSpec` JSON.
- Response: `application/json` `{ type: "response", data: <LLMResponse> }`.

### `POST /stream`
- Body: `LLMCallSpec` JSON.
- Response: SSE `text/event-stream` where each event is a raw `LLMStreamEvent`
  JSON object framed as `data: <json>\n\n`.

### `POST /vector/run`
- Body: `VectorCallSpec` JSON.
- Response: `application/json` `{ type: "response", data: <VectorOperationResult> }`.

### `POST /vector/stream`
- Body: `VectorCallSpec` JSON.
- Response: SSE `text/event-stream` where each event is a raw `VectorStreamEvent`
  JSON object framed as `data: <json>\n\n`.

### `POST /vector/embeddings/run`
- Body: `EmbeddingCallSpec` JSON.
- Response: `application/json` `{ type: "response", data: <EmbeddingOperationResult> }`.

## Validation, Limits, Concurrency

- **Content-Type**: If `Content-Type` is present and not `application/json`, the server returns `415`.
  Missing `Content-Type` is accepted for CLI parity.
- **Body limits**: JSON bodies larger than `maxRequestBytes` return `413`.
  Body reads exceeding `bodyReadTimeoutMs` return `408`.
- **Spec validation**: Incoming specs are structurally validated (Ajv). Invalid specs return `400`
  with `error.code="validation_error"` and a `details` array.
- **Concurrency & queueing**: `/run`, `/stream`, `/vector/run`, `/vector/stream`, and `/vector/embeddings/run`
  each have independent limiters.
  When saturated, requests enter a bounded FIFO queue up to `maxQueueSize`.
  Queue waits longer than `queueTimeoutMs` return `503` with `error.code="queue_timeout"`.
  Vector and embedding limiters can be tuned independently via the `vector*` and `embedding*` options.

## Auth & Security Controls

- **Auth (opt‑in):** when `auth.enabled=true`, requests must include either:
  - `Authorization: Bearer <key>` or
  - `<headerName>: <key>` (default `x-api-key`).
  Multiple active keys are supported for rotation.
- **Hashed keys (optional):** if `auth.hashedKeys` is provided, the server will also accept
  keys whose SHA‑256 digest matches an entry (values may be prefixed with `sha256:`).
- **Rate limiting (opt‑in):** when `rateLimit.enabled=true`, requests are token‑bucket limited
  per client key (auth identity when present, otherwise IP). Exceeding the bucket returns `429`.
- **CORS (opt‑in):** when `cors.enabled=true`, the server sets standard CORS headers on responses
  and handles OPTIONS preflight with `204`.
- **Security headers:** when `securityHeadersEnabled=true`, responses include safe defaults like
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.

### Errors
- Error shape (HTTP and SSE): `{ type: "error", error: { message, code, details? } }`.
- Common HTTP codes:
  - `400` `validation_error` / `invalid_json` / `bad_request`
  - `408` `body_read_timeout`
  - `413` `payload_too_large`
  - `415` `unsupported_media_type`
  - `429` `rate_limited`
  - `503` `server_busy` / `queue_timeout`
  - `504` `timeout`
  - `500` `internal`
- `/stream` timeouts are sent as SSE errors with `code="timeout"` or `code="stream_idle_timeout"`,
  then the connection closes.

## Example

```ts
import { createServer } from '@/utils/server/index.ts';

const server = await createServer({ port: 3000 });
console.log(server.url);

// later
await server.close();
```
