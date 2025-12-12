# Server Utilities

Transport-only HTTP/SSE server for exposing the coordinator over the network.

## Purpose
This module provides a minimal, high-performance Node `http` server that accepts
the same `LLMCallSpec` JSON used by the CLI and returns identical responses or
stream events.

It contains **no** LLM logic; it is a thin transport adapter around the existing
coordinator lifecycle helpers.

## Module Layout
- `utils/server/index.ts` — public API.
- `utils/server/internal/*` — private implementation details (router, body parser, SSE writer).

Only `index.ts` should be imported by other code.

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
- `requestTimeoutMs` (number, default `0` = disabled) — total wall‑clock timeout for `/run` and `/stream`.
- `streamIdleTimeoutMs` (number, default `60000`) — max idle gap between SSE events before closing.
- `maxConcurrentRequests` (number, default `128`) — concurrent `/run` executions.
- `maxConcurrentStreams` (number, default `32`) — concurrent `/stream` executions.
- `maxQueueSize` (number, default `1000`) — queued requests per limiter when saturated.
- `queueTimeoutMs` (number, default `30000`) — max time a request may wait in the queue.
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

## Validation, Limits, Concurrency

- **Content-Type**: If `Content-Type` is present and not `application/json`, the server returns `415`.
  Missing `Content-Type` is accepted for CLI parity.
- **Body limits**: JSON bodies larger than `maxRequestBytes` return `413`.
  Body reads exceeding `bodyReadTimeoutMs` return `408`.
- **Spec validation**: Incoming specs are structurally validated (Ajv). Invalid specs return `400`
  with `error.code="validation_error"` and a `details` array.
- **Concurrency & queueing**: `/run` and `/stream` each have independent limiters.
  When saturated, requests enter a bounded FIFO queue up to `maxQueueSize`.
  Queue waits longer than `queueTimeoutMs` return `503` with `error.code="queue_timeout"`.

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
