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
    "llmPriority": [{"provider":"anthropic","model":"claude-sonnet-4-20250514"}],
    "settings": {}
  }'
```

---

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
| `batchId` | `--batch-id <id>` | | Batch identifier for logging |

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

### Security: Authentication

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `auth.enabled` | `--auth-enabled` | `false` | Enable authentication |
| `auth.allowBearer` | `--no-auth-allow-bearer` | `true` | Allow Bearer token auth |
| `auth.allowApiKeyHeader` | `--no-auth-allow-api-key-header` | `true` | Allow x-api-key header |
| `auth.headerName` | `--auth-header-name <name>` | | Custom auth header name |
| `auth.realm` | `--auth-realm <realm>` | | Authentication realm |
| `auth.apiKeys` | (config only) | | Array of valid API keys |
| `auth.hashedKeys` | (config only) | | Array of SHA-256 hashed keys |

### Security: Rate Limiting

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `rateLimit.enabled` | `--rate-limit-enabled` | `false` | Enable rate limiting |
| `rateLimit.requestsPerMinute` | `--rate-limit-requests-per-minute <n>` | | Requests per minute per client |
| `rateLimit.burst` | `--rate-limit-burst <n>` | | Burst allowance |
| `rateLimit.trustProxyHeaders` | `--rate-limit-trust-proxy-headers` | `false` | Trust X-Forwarded-For headers |

### Security: CORS and Headers

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `cors.enabled` | `--cors-enabled` | `false` | Enable CORS |
| `cors.allowedOrigins` | (config only) | | Array of allowed origins or `"*"` |
| `cors.allowedHeaders` | (config only) | | Array of allowed headers |
| `cors.allowCredentials` | (config only) | | Allow credentials |
| `securityHeadersEnabled` | `--no-security-headers-enabled` | `true` | Add security headers to responses |

---

## Endpoints

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
    "llmPriority": [{"provider":"anthropic","model":"claude-sonnet-4-20250514"}],
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
    "model": "claude-sonnet-4-20250514",
    "provider": "anthropic"
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
    "llmPriority": [{"provider":"anthropic","model":"claude-sonnet-4-20250514"}],
    "settings": {}
  }'
```

**Response (SSE):**

```
data: {"type":"message_start","message":{"id":"msg_...","model":"claude-sonnet-4-20250514"}}

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
    "store": "qdrant-local",
    "embeddingPriority": [{"provider": "openrouter-embeddings"}],
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
    "store": "qdrant-local",
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
    "store": "qdrant-local",
    "input": {"ids": ["doc1", "doc2"]}
  }'
```

**Example - Collections:**

```bash
curl http://127.0.0.1:3000/vector/run \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "collections",
    "store": "qdrant-local",
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
    "embeddingPriority": [{"provider": "openrouter-embeddings"}],
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
    "model": "openai/text-embedding-3-small"
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
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
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
    }
  },

  // Tools (optional)
  "functionToolNames": ["test.echo"],
  "tools": [...],
  "mcpServers": ["testmcp"],
  "toolChoice": "auto",

  // Vector/RAG (optional)
  "vectorContext": {
    "stores": ["qdrant-local"],
    "mode": "auto",
    "topK": 5,
    "embeddingPriority": [{"provider": "openrouter-embeddings"}]
  },

  // Metadata (optional)
  "metadata": {
    "correlationId": "request-123"
  }
}
```

### VectorCallSpec

```typescript
{
  // Operation (required)
  "operation": "embed" | "upsert" | "query" | "delete" | "collections",

  // Store ID (required)
  "store": "qdrant-local",

  // Collection (optional)
  "collection": "my-docs",

  // Embedding priority (required for embed/query with text)
  "embeddingPriority": [{"provider": "openrouter-embeddings"}],

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
  "embeddingPriority": [{"provider": "openrouter-embeddings"}],

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
llm-adapter serve --auth-enabled --port 3000
```

```typescript
// Programmatically
const server = await createServer({
  port: 3000,
  auth: {
    enabled: true,
    allowBearer: true,
    allowApiKeyHeader: true,
    apiKeys: ['key1', 'key2']
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
    enabled: true,
    hashedKeys: [
      '5e884898da28047d9...', // SHA-256 of actual key
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
      "enabled": false,
      "allowBearer": true,
      "allowApiKeyHeader": true
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
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514",
        "settings": {"temperature": 0.3}
      },
      {
        "provider": "openai",
        "model": "gpt-4"
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
    "llmPriority": [{"provider": "anthropic", "model": "claude-sonnet-4-20250514"}],
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
    "llmPriority": [{"provider": "anthropic", "model": "claude-sonnet-4-20250514"}],
    "settings": {},
    "vectorContext": {
      "stores": ["qdrant-local"],
      "mode": "auto",
      "topK": 5,
      "embeddingPriority": [{"provider": "openrouter-embeddings"}],
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
    "embeddingPriority": [{"provider": "openrouter-embeddings"}],
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
    "store": "qdrant-local",
    "collection": "my-docs",
    "embeddingPriority": [{"provider": "openrouter-embeddings"}],
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
    llmPriority: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }],
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
    llmPriority: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }],
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
    'llmPriority': [{'provider': 'anthropic', 'model': 'claude-sonnet-4-20250514'}],
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
    'llmPriority': [{'provider': 'anthropic', 'model': 'claude-sonnet-4-20250514'}],
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
| `ANTHROPIC_API_KEY` | Anthropic provider API key |
| `OPENAI_API_KEY` | OpenAI provider API key |
| `GOOGLE_API_KEY` | Google provider API key |
| `OPENROUTER_API_KEY` | OpenRouter provider API key |
| `EMBEDDING_API_KEY` | Embedding provider API key |
| `VECTOR_STORE_API_KEY` | Vector store API key |

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
