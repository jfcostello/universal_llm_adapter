# LLM Adapter Server Manual

Complete reference for the LLM Adapter HTTP/SSE server.

## Quick Start

```bash
# Start server on port 3000
llm-adapter serve --port 3000

# Make a request
curl http://127.0.0.1:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":[{"type":"text","text":"Hello"}]}],
    "llmPriority": [{"provider":"example-llm","model":"example-model"}],
    "settings": {}
  }'
```

---

## External packs

To load plugins/extensions from directories **outside** the core repo, configure pack roots via `llm-adapter.paths.json` (or `LLM_ADAPTER_PATHS_FILE`).

See [README-PACKS.md](README-PACKS.md).

## Starting the Server

### Via CLI

```bash
llm-adapter serve [options]
```

### Programmatically

```typescript
import { createServer } from 'llm-adapter/server';

const server = await createServer({
  port: 3000,
  host: '127.0.0.1'
});

console.log(server.url);  // http://127.0.0.1:3000

// Shutdown
await server.close();
```

---

## Server Options

### Basic Options

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `host` | `--host <host>` | `127.0.0.1` | Host to bind |
| `port` | `--port <port>` | `0` | Port to bind (0 = ephemeral) |
| `pluginsPath` | `-p, --plugins <path>` | `./plugins` | Path to plugins directory |
| `batchId` | `--batch-id <id>` | | Default batch identifier for logging (requests can override observability grouping via `spec.metadata.batchId`) |
| `extensions.enabled` | `--extension <name>` (repeatable) | `[]` | Enable server extensions by name (adds new endpoints/commands) |

### Extensions

Extensions are optional feature packs that bolt new “services” onto the adapter (new endpoints, new CLI command groups) without polluting core modules.

Enable via:
- Config: `server.extensions.enabled: ["<extensionName>"]`
- CLI: `llm-adapter serve --extension <extensionName>` (repeatable)
- Programmatically: `createServer({ extensions: { enabled: ["<extensionName>"] } })`

See `extensions/README.md`.

### Request Handling

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `maxRequestBytes` | `--max-request-bytes <n>` | `26214400` (25MB) | Maximum request body size |
| `bodyReadTimeoutMs` | `--body-read-timeout-ms <n>` | `10000` | Timeout for reading request body |
| `requestTimeoutMs` | `--request-timeout-ms <n>` | `0` (disabled) | Overall request timeout |
| `streamIdleTimeoutMs` | `--stream-idle-timeout-ms <n>` | `60000` | Timeout for idle streaming connections |

### Concurrency Limits

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `maxConcurrentRequests` | `--max-concurrent-requests <n>` | `128` | Max concurrent non-streaming requests |
| `maxConcurrentStreams` | `--max-concurrent-streams <n>` | `32` | Max concurrent streaming requests |
| `maxQueueSize` | `--max-queue-size <n>` | `1000` | Max queued requests |
| `queueTimeoutMs` | `--queue-timeout-ms <n>` | `30000` | Timeout for queued requests |

### Vector-Specific Limits

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `maxConcurrentVectorRequests` | `--max-concurrent-vector-requests <n>` | `128` | Max concurrent vector requests |
| `maxConcurrentVectorStreams` | `--max-concurrent-vector-streams <n>` | `32` | Max concurrent vector streams |
| `vectorMaxQueueSize` | `--vector-max-queue-size <n>` | `1000` | Max queued vector requests |
| `vectorQueueTimeoutMs` | `--vector-queue-timeout-ms <n>` | `30000` | Timeout for queued vector requests |

### Embedding-Specific Limits

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `maxConcurrentEmbeddingRequests` | `--max-concurrent-embedding-requests <n>` | `128` | Max concurrent embedding requests |
| `embeddingMaxQueueSize` | `--embedding-max-queue-size <n>` | `1000` | Max queued embedding requests |
| `embeddingQueueTimeoutMs` | `--embedding-queue-timeout-ms <n>` | `30000` | Timeout for queued embedding requests |

### Realtime (WebSocket)

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `realtime.enabled` | `--realtime-enabled` | `false` | Enable realtime WebSocket endpoint |
| `realtime.wsPath` | `--realtime-ws-path <path>` | `/realtime/ws` | WebSocket path for realtime sessions |
| `realtime.maxWsMessageBytes` | `--realtime-max-ws-message-bytes <n>` | `262144` | Maximum WebSocket message size |
| `realtime.wsIdleTimeoutMs` | `--realtime-ws-idle-timeout-ms <n>` | `60000` | WebSocket idle timeout |
| `realtime.openHandshakeTimeoutMs` | `--realtime-open-handshake-timeout-ms <n>` | `60000` | WebSocket open handshake timeout |
| `realtime.maxConcurrentSessions` | `--realtime-max-concurrent-sessions <n>` | `20` | Max concurrent realtime sessions |
| `realtime.maxAudioBytesPerSecond` | `--realtime-max-audio-bytes-per-second <n>` | `256000` | Max audio throughput per session (bytes/sec) |
| `realtime.maxSessionDurationMs` | `--realtime-max-session-duration-ms <n>` | `3600000` | Max realtime session duration |

### Security: Authentication

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `auth.mode` | `--auth-mode <mode>` | `none` | Auth mode (`none`, `apiKey`, `jwt`, `proxySigned`) |
| `auth.allowBearer` | `--no-auth-allow-bearer` | `true` | Allow Bearer token extraction |
| `auth.allowHeader` | `--no-auth-allow-header` | `true` | Allow header token extraction (default `x-api-key`) |
| `auth.headerName` | `--auth-header-name <name>` | `x-api-key` | Custom auth header name |
| `auth.realm` | `--auth-realm <realm>` | | Authentication realm (`WWW-Authenticate`) |
| `auth.keys` | (config only) | | Static keys (`apiKey`/`proxySigned` modes) |
| `auth.spki` | (config only) | | Static public key in SPKI PEM format (`jwt` mode) |
| `auth.jwksUrl` | (config only) | | JWKS URL (`jwt` mode) |
| `auth.jwks` | (config only) | | Inline JWKS (`jwt` mode) |

Notes:
- For `apiKey` mode, raw keys can be supplied via `LLM_ADAPTER_API_KEYS` (comma-separated) when `auth.keys` is omitted.

### Security: Policy

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `policy.documents.filepath.enabled` | `--policy-documents-filepath-enabled` | `false` | Allow `document.source.type="filepath"` in server requests |
| `policy.documents.filepath.allowedRoots` | `--policy-documents-filepath-root <path>` | `[]` | Allowed roots for filepath docs (repeatable); empty defaults to server cwd |

Notes:
- Enforcement resolves both the requested file path and each allowed root via `realpath`, preventing symlink escapes.

### Security: Rate Limiting

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `rateLimit.enabled` | `--rate-limit-enabled` | `false` | Enable rate limiting |
| `rateLimit.requestsPerMinute` | `--rate-limit-requests-per-minute <n>` | | Requests per minute per client |
| `rateLimit.burst` | `--rate-limit-burst <n>` | | Burst allowance |
| `rateLimit.trustProxyHeaders` | `--rate-limit-trust-proxy-headers` | `false` | Trust X-Forwarded-For headers |
| `rateLimit.maxKeys` | `--rate-limit-max-keys <n>` | `10000` | Max distinct identities tracked in memory |
| `rateLimit.keyTtlMs` | `--rate-limit-key-ttl-ms <n>` | `0` | Optional identity TTL (0 disables TTL eviction) |

### Security: CORS and Headers

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `cors.enabled` | `--cors-enabled` | `false` | Enable CORS |
| `cors.allowedOrigins` | (config only) | | Array of allowed origins or `"*"` |
| `cors.allowedHeaders` | (config only) | | Array of allowed headers |
| `cors.allowCredentials` | (config only) | | Allow credentials |
| `securityHeadersEnabled` | `--no-security-headers-enabled` | `true` | Add security headers to responses |

### HTTP Server Hardening

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `httpHeadersTimeoutMs` | `--http-headers-timeout-ms <n>` | `20000` | Node `server.headersTimeout` (slowloris protection) |
| `httpRequestTimeoutMs` | `--http-request-timeout-ms <n>` | `0` | Node `server.requestTimeout` (0 disables) |
| `httpKeepAliveTimeoutMs` | `--http-keep-alive-timeout-ms <n>` | `5000` | Node `server.keepAliveTimeout` |
| `httpMaxHeadersCount` | `--http-max-headers-count <n>` | `1000` | Node `server.maxHeadersCount` |

---

## Endpoints

Core endpoints below are always available. Extensions can register additional endpoints when enabled; see the relevant extension README under `extensions/`.

### Health Check

```
GET /health
```

Always returns 200 with `{"ok": true}`.

**Example:**

```bash
curl http://127.0.0.1:3000/health
```

**Response:**

```json
{"ok": true}
```

### Readiness Check

```
GET /ready
```

Returns 200 when ready, 503 when not ready.

**Example:**

```bash
curl http://127.0.0.1:3000/ready
```

**Response (ready):**

```json
{"ok": true}
```

**Response (not ready):**

```json
{"ok": false}
```

### Extensions List

```
GET /extensions/list
```

Lists available extensions across configured pack roots (same shape as `llm-adapter extensions list`).

Notes:

- Requires auth when `auth.mode != "none"` (401/403 on failure).
- Subject to rate limiting when `rateLimit.enabled: true` (429 on limit).

**Example:**

```bash
curl http://127.0.0.1:3000/extensions/list
```

### Realtime WebSocket

```
GET /realtime/ws
```

Realtime sessions over WebSocket using the same message/envelope contract as `llm-adapter realtime`:

- Client messages: `open`, `send_text`, `send_audio`, `commit`, `interrupt`, `close`
- Server envelopes: `{ "type": "event", ... }` and `{ "type": "error", ... }`

**Contract notes:**

- The first emitted event must be `{ "type": "ready", ... }`.
- `spec.provider` must reference a realtime provider id from `plugins/realtime-providers/*.json`.
- Authentication must be enabled (`auth.mode != "none"`) for this endpoint.
- Configure limits via the `realtime.*` options (message size, idle timeout, concurrency, audio rate, max duration).
- The WebSocket idle timeout defaults to `realtime.wsIdleTimeoutMs` and is updated to `spec.timeout.idleTimeoutMs` after `open` (when provided).

### LLM Run (Non-Streaming)

```
POST /run
Content-Type: application/json
```

Execute a non-streaming LLM call.

**Request Body:** `LLMCallSpec` (see [Spec Reference](#llmcallspec))

**Example:**

```bash
curl http://127.0.0.1:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":[{"type":"text","text":"Hello"}]}],
    "llmPriority": [{"provider":"example-llm","model":"example-model"}],
    "settings": {}
  }'
```

**Response:**

```json
{
  "type": "response",
  "data": {
    "content": [{"type": "text", "text": "Hello! How can I help you today?"}],
    "stopReason": "end_turn",
    "usage": {
      "inputTokens": 10,
      "outputTokens": 15
    },
    "model": "example-model",
    "provider": "example-llm"
  }
}
```

### LLM Stream (Streaming)

```
POST /stream
Content-Type: application/json
```

Execute a streaming LLM call. Returns Server-Sent Events.

**Request Body:** `LLMCallSpec` (see [Spec Reference](#llmcallspec))

**Example:**

```bash
curl http://127.0.0.1:3000/stream \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":[{"type":"text","text":"Write a haiku"}]}],
    "llmPriority": [{"provider":"example-llm","model":"example-model"}],
    "settings": {}
  }'
```

**Response (SSE):**

```
data: {"type":"message_start","message":{"id":"msg_...","model":"example-model"}}

data: {"type":"delta","text":"Silent"}

data: {"type":"delta","text":" morning"}

data: {"type":"delta","text":" dew"}

data: {"type":"message_stop","stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":20}}
```

### Vector Run (Non-Streaming)

```
POST /vector/run
Content-Type: application/json
```

Execute a non-streaming vector operation.

**Request Body:** `VectorCallSpec` (see [Spec Reference](#vectorcallspec))

**Example - Query:**

```bash
curl http://127.0.0.1:3000/vector/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "query",
    "store": "memory",
    "embeddingPriority": [{"provider": "example-embeddings"}],
    "input": {"query": "machine learning", "topK": 5}
  }'
```

**Response:**

```json
{
  "type": "response",
  "data": {
    "operation": "query",
    "results": [
      {"id": "doc1", "score": 0.95, "payload": {"text": "Machine learning is..."}},
      {"id": "doc2", "score": 0.87, "payload": {"text": "Deep learning..."}}
    ]
  }
}
```

**Example - Upsert:**

```bash
curl http://127.0.0.1:3000/vector/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "upsert",
    "store": "memory",
    "input": {
      "points": [
        {"id": "doc1", "vector": [0.1, 0.2, 0.3], "payload": {"text": "Hello"}}
      ]
    }
  }'
```

**Example - Delete:**

```bash
curl http://127.0.0.1:3000/vector/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "delete",
    "store": "memory",
    "input": {"ids": ["doc1", "doc2"]}
  }'
```

**Example - Collections:**

```bash
curl http://127.0.0.1:3000/vector/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "collections",
    "store": "memory",
    "input": {"collectionOp": "list"}
  }'
```

### Vector Stream (Streaming)

```
POST /vector/stream
Content-Type: application/json
```

Execute a streaming vector operation. Useful for batch operations.

**Request Body:** `VectorCallSpec`

**Response (SSE):**

```
data: {"type":"progress","processed":10,"total":100}

data: {"type":"progress","processed":20,"total":100}

data: {"type":"result","operation":"embed","vectors":[...]}
```

### Embeddings Run

```
POST /embeddings/run
Content-Type: application/json
```

Execute an embedding operation.

**Request Body:** `EmbeddingCallSpec` (see [Spec Reference](#embeddingcallspec))

**Example:**

```bash
curl http://127.0.0.1:3000/embeddings/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "embed",
    "embeddingPriority": [{"provider": "example-embeddings"}],
    "input": {"texts": ["Hello world", "Machine learning"]}
  }'
```

**Response:**

```json
{
  "type": "response",
  "data": {
    "operation": "embed",
    "vectors": [[0.1, 0.2, ...], [0.3, 0.4, ...]],
    "dimensions": 1536,
    "model": "example/embedding-model"
  }
}
```

---

## Spec Reference

### LLMCallSpec

```typescript
{
  // System prompt (optional)
  "systemPrompt": "You are a helpful assistant.",

  // Messages (required)
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Hello"}
      ]
    }
  ],

  // Provider priority list (required)
  "llmPriority": [
    {
      "provider": "example-llm",
      "model": "example-model",
      "settings": {}  // Optional per-provider override
    }
  ],

  // Settings (required, can be empty)
  "settings": {
    "temperature": 0.7,
    "topP": 1.0,
    "maxTokens": 4096,
    "stop": ["END"],
    "reasoning": {
      "enabled": true,
      "effort": "medium",
      "budget": 10000
    },
    "usageCost": false
  },

  // Tools (optional)
  "functionToolNames": ["test.echo"],
  "tools": [...],
  "mcpServers": ["testmcp"],
  "toolChoice": "auto",

  // Vector/RAG (optional)
  "vectorContext": {
    "stores": ["memory"],
    "mode": "auto",
    "topK": 5,
    "embeddingPriority": [{"provider": "example-embeddings"}]
  },

  // Metadata (optional)
  "metadata": {
    "correlationId": "request-123"
  }
}
```

#### Terminal Tool Calls

Tools can be marked as **terminal** so the tool loop stops immediately after tool execution (no follow-up LLM call). This is useful when the tool execution is the final action.

- Tool definition: set `"terminal": true` on the tool definition (plugin tool JSON or inline `tools` entry).
- Tool result override (per-call): include `tool_type_response_override_terminal: true|false` in the tool return payload (top-level or nested inside `result`; top-level wins). Only strict booleans are honored.

When terminal, the response `finishReason` is set to `tool_stop`.

### Usage Cost Calculation

When a provider response omits cost, set `settings.usageCost` to opt into local cost calculation.
Costs are loaded from `plugins/configs/usage-costs.json` and are defined per provider/model in
**cost-per-million tokens**.

### VectorCallSpec

```typescript
{
  // Operation (required)
  "operation": "embed" | "upsert" | "query" | "delete" | "collections",

  // Store ID (required)
  "store": "memory",

  // Collection (optional)
  "collection": "my-docs",

  // Embedding priority (required for embed/query with text)
  "embeddingPriority": [{"provider": "example-embeddings"}],

  // Operation-specific input (required)
  "input": {...},

  // Settings (optional)
  "settings": {
    "batchSize": 10
  },

  // Metadata (optional)
  "metadata": {
    "correlationId": "request-123"
  }
}
```

### EmbeddingCallSpec

```typescript
{
  // Operation (required)
  "operation": "embed",

  // Embedding priority (required)
  "embeddingPriority": [{"provider": "example-embeddings"}],

  // Input (required)
  "input": {
    "text": "Single text"
  }
  // OR
  "input": {
    "texts": ["Multiple", "texts"]
  },

  // Metadata (optional)
  "metadata": {
    "correlationId": "request-123"
  }
}
```

---

## Security Configuration

### Authentication

Enable authentication to require API keys:

```bash
# Via CLI
llm-adapter serve --auth-mode apiKey --port 3000
```

```typescript
// Programmatically
const server = await createServer({
  port: 3000,
  auth: {
    mode: 'apiKey',
    allowBearer: true,
    allowHeader: true,
    keys: [
      { id: 'key1', token: 'key1' },
      { id: 'key2', token: 'key2' }
    ]
  }
});
```

**Making authenticated requests:**

```bash
# Bearer token
curl http://127.0.0.1:3000/run \
  -H "Authorization: Bearer key1" \
  -H "Content-Type: application/json" \
  -d '...'

# x-api-key header
curl http://127.0.0.1:3000/run \
  -H "x-api-key: key1" \
  -H "Content-Type: application/json" \
  -d '...'
```

**Using hashed keys:**

Store SHA-256 hashes instead of plaintext keys:

```typescript
const server = await createServer({
  port: 3000,
  auth: {
    mode: 'apiKey',
    keys: [
      { id: 'key1', sha256: 'sha256:5e884898da28047d9...' } // SHA-256 of the actual key
    ]
  }
});
```

### Rate Limiting

Limit requests per client:

```bash
# Via CLI
llm-adapter serve --rate-limit-enabled \
  --rate-limit-requests-per-minute 60 \
  --rate-limit-burst 10 \
  --port 3000
```

```typescript
// Programmatically
const server = await createServer({
  port: 3000,
  rateLimit: {
    enabled: true,
    requestsPerMinute: 60,
    burst: 10,
    trustProxyHeaders: false
  }
});
```

When rate limited, the server returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60

{"error": "Rate limit exceeded"}
```

### CORS

Enable Cross-Origin Resource Sharing:

```bash
# Via CLI
llm-adapter serve --cors-enabled --port 3000
```

```typescript
// Programmatically
const server = await createServer({
  port: 3000,
  cors: {
    enabled: true,
    allowedOrigins: ['https://example.com', 'https://app.example.com'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    allowCredentials: true
  }
});

// Or allow all origins
const server = await createServer({
  port: 3000,
  cors: {
    enabled: true,
    allowedOrigins: '*'
  }
});
```

### Security Headers

By default, the server adds security headers to all responses:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

Disable with:

```bash
llm-adapter serve --no-security-headers-enabled --port 3000
```

---

## Configuration via defaults.json

Server defaults can be configured in `plugins/configs/defaults.json`:

```json
{
  "server": {
    "maxRequestBytes": 26214400,
    "bodyReadTimeoutMs": 10000,
    "requestTimeoutMs": 0,
    "streamIdleTimeoutMs": 60000,
    "maxConcurrentRequests": 128,
    "maxConcurrentStreams": 32,
    "maxQueueSize": 1000,
    "queueTimeoutMs": 30000,
    "auth": {
      "mode": "none"
    },
    "rateLimit": {
      "enabled": false,
      "requestsPerMinute": 60,
      "burst": 10
    },
    "cors": {
      "enabled": false
    },
    "securityHeadersEnabled": true
  }
}
```

**Important:** API keys and sensitive data should be set via environment variables or programmatic configuration, not in defaults.json.

---

## Error Responses

### 400 Bad Request

Invalid request body or spec:

```json
{"error": "Invalid JSON", "details": "..."}
```

### 401 Unauthorized

Authentication required but not provided:

```json
{"error": "Unauthorized"}
```

### 403 Forbidden

Invalid API key:

```json
{"error": "Forbidden"}
```

### 429 Too Many Requests

Rate limit exceeded:

```json
{"error": "Rate limit exceeded"}
```

Headers:
```
Retry-After: 60
```

### 500 Internal Server Error

Server error:

```json
{"error": "Internal server error", "details": "..."}
```

### 503 Service Unavailable

Server not ready or overloaded:

```json
{"error": "Service unavailable"}
```

---

## Streaming Error Handling

For streaming endpoints (`/stream`, `/vector/stream`), errors are sent as SSE events:

```
data: {"type":"error","error":"Provider error","details":"..."}
```

The connection then closes.

---

## Request Examples

### Complete LLM Request

```bash
curl http://127.0.0.1:3000/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "systemPrompt": "You are a helpful coding assistant.",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "Write a function to calculate fibonacci numbers"}
        ]
      }
    ],
    "llmPriority": [
      {
        "provider": "example-llm",
        "model": "example-model",
        "settings": {"temperature": 0.3}
      },
      {
        "provider": "example-llm-2",
        "model": "example-model-2"
      }
    ],
    "settings": {
      "temperature": 0.7,
      "maxTokens": 2048
    },
    "metadata": {
      "correlationId": "req-12345"
    }
  }'
```

### Streaming with Tools

```bash
curl http://127.0.0.1:3000/stream \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "Echo hello world"}]}
    ],
    "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
    "settings": {},
    "functionToolNames": ["test.echo"]
  }'
```

### RAG Query

```bash
curl http://127.0.0.1:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "What is machine learning?"}]}
    ],
    "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
    "settings": {},
    "vectorContext": {
      "stores": ["memory"],
      "mode": "auto",
      "topK": 5,
      "embeddingPriority": [{"provider": "example-embeddings"}],
      "injectAs": "system",
      "injectTemplate": "Use this context:\n{{results}}"
    }
  }'
```

### Batch Embedding

```bash
curl http://127.0.0.1:3000/embeddings/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "embed",
    "embeddingPriority": [{"provider": "example-embeddings"}],
    "input": {
      "texts": [
        "First document text",
        "Second document text",
        "Third document text"
      ]
    }
  }'
```

### Vector Upsert with Embeddings

```bash
curl http://127.0.0.1:3000/vector/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "embed",
    "store": "memory",
    "collection": "my-docs",
    "embeddingPriority": [{"provider": "example-embeddings"}],
    "input": {
      "texts": ["Document 1", "Document 2"],
      "ids": ["doc1", "doc2"],
      "payloads": [{"title": "First"}, {"title": "Second"}],
      "upsert": true
    }
  }'
```

---

## Client Libraries

### Node.js/TypeScript

```typescript
// Non-streaming
const response = await fetch('http://127.0.0.1:3000/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    llmPriority: [{ provider: 'example-llm', model: 'example-model' }],
    settings: {}
  })
});

const result = await response.json();
console.log(result.data.content[0].text);
```

```typescript
// Streaming
const response = await fetch('http://127.0.0.1:3000/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    llmPriority: [{ provider: 'example-llm', model: 'example-model' }],
    settings: {}
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      if (event.type === 'delta') {
        process.stdout.write(event.text);
      }
    }
  }
}
```

### Python

```python
import requests

# Non-streaming
response = requests.post('http://127.0.0.1:3000/run', json={
    'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'Hello'}]}],
    'llmPriority': [{'provider': 'example-llm', 'model': 'example-model'}],
    'settings': {}
})

result = response.json()
print(result['data']['content'][0]['text'])
```

```python
import requests
import json

# Streaming
response = requests.post('http://127.0.0.1:3000/stream', json={
    'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'Hello'}]}],
    'llmPriority': [{'provider': 'example-llm', 'model': 'example-model'}],
    'settings': {}
}, stream=True)

for line in response.iter_lines():
    if line:
        line = line.decode('utf-8')
        if line.startswith('data: '):
            event = json.loads(line[6:])
            if event.get('type') == 'delta':
                print(event.get('text', ''), end='')
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `LLM_ADAPTER_BATCH_ID` | Default batch ID for logging |
| `LLM_ADAPTER_BATCH_DIR` | Use batch-based directories ("1" or "0") |
| `LLM_ADAPTER_DISABLE_FILE_LOGS` | Disable file logging ("1") |
| `LLM_ADAPTER_DISABLE_CONSOLE_LOGS` | Disable console logging ("1") |
| `LLM_ADAPTER_VOICE_LOG_MAX_FILES` | Max retained voice log files |
| `LLM_ADAPTER_VOICE_LOG_MAX_AGE_DAYS` | Max age of voice log files |
| `LLM_ADAPTER_REALTIME_LOG_MAX_FILES` | Max retained realtime log files |
| `LLM_ADAPTER_REALTIME_LOG_MAX_AGE_DAYS` | Max age of realtime log files |
| `LLM_API_KEY` | LLM provider API key |
| `EMBEDDINGS_API_KEY` | Embedding provider API key |
| `VECTOR_STORE_API_KEY` | Vector store API key |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (for observability) |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (for observability) |

### Observability (Optional)

Enable LLM call and realtime session telemetry export in your request body/spec:

```json
{
  "observability": {
    "enabled": true,
    "provider": "langfuse",
    "captureMessages": "text"
  },
  "messages": [...],
  "llmPriority": [...]
}
```

Tip: set `metadata.correlationId` (trace name) and `metadata.tags` (tags) for stable naming/grouping.

Or globally via `plugins/configs/defaults.json`. Same spec field for CLI and server.

---

## Performance Tuning

### High Throughput

For high-throughput scenarios:

```bash
llm-adapter serve \
  --port 3000 \
  --max-concurrent-requests 256 \
  --max-concurrent-streams 64 \
  --max-queue-size 2000 \
  --queue-timeout-ms 60000
```

### Memory Constrained

For memory-constrained environments:

```bash
llm-adapter serve \
  --port 3000 \
  --max-concurrent-requests 32 \
  --max-concurrent-streams 8 \
  --max-queue-size 100 \
  --max-request-bytes 5242880
```

### Long-Running Requests

For requests that may take a long time:

```bash
llm-adapter serve \
  --port 3000 \
  --request-timeout-ms 300000 \
  --stream-idle-timeout-ms 120000
```
