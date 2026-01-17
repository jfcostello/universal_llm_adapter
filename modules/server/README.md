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
- `modules/server/internal/security/*` — policy, rate limiting, CORS, security headers.
- `modules/server/internal/streaming/*` — SSE helpers.

Only `index.ts` should be imported by other code.

## Public API

### `createServer(options?): Promise<RunningServer>`

Starts an HTTP server.

Options:
- `host` (string, default `"127.0.0.1"`)
- `port` (number, default `0` for ephemeral)
- `pluginsPath` (string, default `"./plugins"`)
- `batchId` (string, optional) — default batch ID for logging and observability session/grouping when `spec.metadata.batchId` is not provided per-request.
- `closeLoggerAfterRequest` (boolean, default `false`)
- `maxRequestBytes` (number, default `26214400` / 25MB) — maximum JSON body size including any embedded base64.
- `bodyReadTimeoutMs` (number, default `10000`) — timeout while reading the request body.
- `requestTimeoutMs` (number, default `0` = disabled) — total wall‑clock timeout for `/run`, `/vector/run`, `/embeddings/run`, and `/stream`.
- `streamIdleTimeoutMs` (number, default `60000`) — max idle gap between SSE events before closing.
- `maxConcurrentRequests` (number, default `128`) — concurrent `/run` executions.
- `maxConcurrentStreams` (number, default `32`) — concurrent `/stream` executions.
- `maxQueueSize` (number, default `1000`) — queued requests per limiter when saturated.
- `queueTimeoutMs` (number, default `30000`) — max time a request may wait in the queue.
- `maxConcurrentVectorRequests` (number, default `128`) — concurrent `/vector/run` executions.
- `maxConcurrentVectorStreams` (number, default `32`) — concurrent `/vector/stream` executions.
- `vectorMaxQueueSize` (number, default `1000`) — queue size for vector limiters when saturated.
- `vectorQueueTimeoutMs` (number, default `30000`) — max time a vector request may wait in the queue.
- `maxConcurrentEmbeddingRequests` (number, default `128`) — concurrent `/embeddings/run` executions.
- `embeddingMaxQueueSize` (number, default `1000`) — queue size for embedding limiter when saturated.
- `embeddingQueueTimeoutMs` (number, default `30000`) — max time an embedding request may wait in the queue.
- `auth` (`AuthConfig`, default `{ mode: "none" }`) — request authentication.
  - `mode` (`"none" | "apiKey" | "jwt" | "proxySigned"`).
  - `apiKey` fields:
    - `allowBearer` (boolean, default `true`) — accept `Authorization: Bearer <token>`.
    - `allowHeader` (boolean, default `true`) — accept `headerName: <token>`.
    - `headerName` (string, default `"x-api-key"`).
    - `realm` (string, optional) — realm for 401 challenges.
    - `keys` (`{ id, token?, sha256? }[]`) — required (server can also load from `LLM_ADAPTER_API_KEYS` when omitted).
  - `jwt` fields: `jwksUrl`/`jwks`/`spki`, `issuer`, `audience`, `algorithms` (plus the same header extraction fields as `apiKey`).
  - `proxySigned` fields: `keys: [{ id, secret }]`, header mapping + timestamp skew controls.
- `rateLimit` (object, default disabled) — in‑memory token‑bucket limiter per client.
  - `enabled` (boolean)
  - `requestsPerMinute` (number, default `120`)
  - `burst` (number, default `30`)
  - `trustProxyHeaders` (boolean, default `false`) — if true, use `x-forwarded-for` for IP.
  - `maxKeys` (number, default `10000`) — max distinct identities tracked (bounded memory).
  - `keyTtlMs` (number, default `0`) — optional per-identity TTL (0 disables TTL eviction).
- `cors` (object, default disabled) — CORS handling and preflight.
  - `enabled` (boolean)
  - `allowedOrigins` (string[] or `"*"`)
  - `allowedHeaders` (string[], default `["content-type","authorization","x-api-key"]`)
  - `allowCredentials` (boolean, default `false`)
- `policy` (object, optional) — server-side safety gates for dangerous inputs.
  - `documents.filepath.enabled` (boolean, default `false`) — allow `document.source.type="filepath"` in server requests.
  - `documents.filepath.allowedRoots` (string[], default `[]`) — optional allowlist roots; empty defaults to server cwd (symlink-safe via `realpath`).
- `securityHeadersEnabled` (boolean, default `true`) — adds safe browser/proxy hardening headers.
- `httpHeadersTimeoutMs` (number, default `20000`) — Node `server.headersTimeout` (slowloris protection).
- `httpRequestTimeoutMs` (number, default `0`) — Node `server.requestTimeout` (0 disables).
- `httpKeepAliveTimeoutMs` (number, default `5000`) — Node `server.keepAliveTimeout`.
- `httpMaxHeadersCount` (number, default `1000`) — Node `server.maxHeadersCount`.
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

### `GET /health`
- Response: `application/json` `{ ok: true }`.

### `GET /ready`
- Response:
  - `200` with `{ ok: true }` when the server is ready to accept work.
  - `503` with `{ ok: false }` when not ready (e.g., configured `pluginsPath` is missing).

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

### `POST /embeddings/run`
- Body: `EmbeddingCallSpec` JSON.
- Response: `application/json` `{ type: "response", data: <EmbeddingOperationResult> }`.

### `POST /realtime/webrtc/client-secret`

Mints a short-lived client credential suitable for establishing a realtime WebRTC session from a browser/mobile client **without** exposing long-lived provider credentials.

- Auth: **required** (server `auth.mode` must not be `"none"`).
- Rate limiting: uses the server rate limiter when enabled.
- Body:
  - `provider` (string, required) — realtime provider id from `plugins/realtime-providers/*.json`
  - `model` (string, optional)
  - `systemPrompt` (string, optional)
  - `expiresAfterSeconds` (integer, optional) — must be between 30 and 600 seconds when provided
- Response: `application/json` `{ clientSecret: string, expiresAt?: number }`
  - `expiresAt` is a unix timestamp in seconds (when provided by the provider).

Security guidance:
- Never send long-lived provider API keys to browsers/mobile clients.
- Prefer routing all client-secret minting through your own authenticated backend, and apply additional per-user authorization and rate limits as appropriate for your application.

## Validation, Limits, Concurrency

- **Content-Type**: If `Content-Type` is present and not `application/json`, the server returns `415`.
  Missing `Content-Type` is accepted for CLI parity.
- **Body limits**: JSON bodies larger than `maxRequestBytes` return `413`.
  Body reads exceeding `bodyReadTimeoutMs` return `408`.
- **Spec validation**: Incoming specs are structurally validated (Ajv). Invalid specs return `400`
  with `error.code="validation_error"` and a `details` array.
- **Concurrency & queueing**: `/run`, `/stream`, `/vector/run`, `/vector/stream`, and `/embeddings/run`
  each have independent limiters.
  When saturated, requests enter a bounded FIFO queue up to `maxQueueSize`.
  Queue waits longer than `queueTimeoutMs` return `503` with `error.code="queue_timeout"`.
  Vector and embedding limiters can be tuned independently via the `vector*` and `embedding*` options.

## Distributed / multi-instance deployments

All limiters in `modules/server` are **in-memory** and **per-process**:

- Concurrency + queues (`maxConcurrent*`, `maxQueueSize`) apply **per server instance**.
- Rate limiting (`rateLimit.*`) applies **per server instance** (no shared state across replicas).
- Realtime WebSocket limits (for `/realtime/ws`) like `maxConcurrentSessions` and audio throughput limits
  are also **per server instance**.

Implications behind a load balancer with `N` replicas:

- Effective caps are roughly `perInstanceLimit × N` (assuming traffic is spread evenly).
- For realtime WebSockets, you typically also need **sticky sessions / connection affinity** so that a
  given client stays on one instance for the lifetime of the WS connection.

Production guidance:

- If you need **global** rate limits or global concurrency/session caps, enforce them at a higher layer
  (API gateway / reverse proxy) or via a distributed limiter (e.g. Redis-backed) that all instances share.
- In Kubernetes, configure your ingress/controller for WebSocket support and consider session affinity
  if you rely on per-instance connection caps for realtime sessions.

## Auth & Security Controls

- **Auth (opt‑in):** when `auth.mode !== "none"`, requests must be authenticated.
  - `apiKey`: accept `Authorization: Bearer <token>` and/or `headerName: <token>` (default `x-api-key`).
  - `jwt`: accept `Authorization: Bearer <jwt>` and/or `headerName: <jwt>`, then validate offline.
  - `proxySigned`: accept a gateway-signed identity via headers (no JWT verification work per request).
- **API keys from env (server):** when `auth.mode="apiKey"` and `auth.keys` is omitted, keys can be
  loaded from `LLM_ADAPTER_API_KEYS` (comma-separated). Entries can be raw tokens or sha256 digests.
- **Policy gates (server):** dangerous inputs like `document.source.type="filepath"` are disabled by default
  and require `policy.documents.filepath.enabled=true` (optionally restrict with `allowedRoots`).
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
import { createServer } from 'llm-adapter/server';

const server = await createServer({ port: 3000 });
console.log(server.url);

// later
await server.close();
```
