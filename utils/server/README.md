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
- `deps` (partial `ServerDependencies`) — dependency injection for tests/embedding.
- `registry` (`PluginRegistryLike`) — optional pre-built registry.

Returns:
- `url` — base URL.
- `server` — underlying Node server.
- `close()` — shuts down server and closes loggers.

### `createServerHandlerWithDefaults(options)`

Creates a request handler when embedding the server into an existing Node HTTP
server. Requires `options.registry` to be provided.

## Endpoints

### `POST /run`
- Body: `LLMCallSpec` JSON.
- Response: `application/json` `{ type: "response", data: <LLMResponse> }`.

### `POST /stream`
- Body: `LLMCallSpec` JSON.
- Response: SSE `text/event-stream` where each event is a raw `LLMStreamEvent`
  JSON object framed as `data: <json>\n\n`.

### Errors
- Invalid JSON: `400` `{ type: "error", error: { message } }`.
- Other failures: `500` same shape.
- Streaming errors: an SSE `data:` event with `{ type: "error", error: { message } }`
  and the connection closes.

## Example

```ts
import { createServer } from '@/utils/server/index.ts';

const server = await createServer({ port: 3000 });
console.log(server.url);

// later
await server.close();
```

