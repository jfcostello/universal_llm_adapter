# LLM Adapter CLI Manual

Complete reference for the `llm-adapter` command-line interface.

## Installation

```bash
npm install llm-adapter
```

The CLI is available as `llm-adapter` after installation.

## Command Overview

```bash
llm-adapter <command> [options]
```

| Command | Description |
|---------|-------------|
| `run` | Non-streaming LLM call |
| `stream` | Streaming LLM call |
| `vector run` | Non-streaming vector operation |
| `vector stream` | Streaming vector operation |
| `vector embed` | Embed texts (with optional upsert) |
| `vector query` | Query a vector store |
| `vector upsert` | Upsert vectors to a store |
| `vector delete` | Delete vectors by ID |
| `vector collections` | Manage collections |
| `embeddings run` | Execute embedding operation |
| `serve` | Start HTTP/SSE server |
| `realtime` | Realtime session over stdin/stdout JSON protocol |
| `realtime client-secret` | Mint a short-lived realtime WebRTC client secret |

---

## LLM Commands

### `llm-adapter run`

Execute a non-streaming LLM call.

```bash
llm-adapter run --spec '<json>' [options]
llm-adapter run --file <path> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-s, --spec <json>` | Spec as JSON string |
| `-f, --file <path>` | Path to spec JSON file |
| `-p, --plugins <path>` | Path to plugins directory (default: `./plugins`) |
| `--batch-id <id>` | Batch identifier for grouped logging |
| `--pretty` | Pretty print output |

**Example:**

```bash
llm-adapter run --spec '{
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "Hello, how are you?"}]}
  ],
  "llmPriority": [
    {"provider": "example-llm", "model": "example-model"}
  ],
  "settings": {"temperature": 0.7}
}'
```

### `llm-adapter stream`

Execute a streaming LLM call. Returns Server-Sent Events.

```bash
llm-adapter stream --spec '<json>' [options]
llm-adapter stream --file <path> [options]
```

**Options:** Same as `run`.

**Example:**

```bash
llm-adapter stream --spec '{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "Write a poem"}]}],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {}
}'
```

---

## Vector Commands

### `llm-adapter vector run`

Execute any vector operation from a VectorCallSpec.

```bash
llm-adapter vector run --spec '<json>' [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-s, --spec <json>` | Spec as JSON string |
| `-f, --file <path>` | Path to spec JSON file |
| `-p, --plugins <path>` | Path to plugins directory (default: `./plugins`) |
| `--batch-id <id>` | Batch identifier for grouped logging |
| `--pretty` | Pretty print output |

### `llm-adapter vector stream`

Stream vector operation events (useful for batch operations).

```bash
llm-adapter vector stream --spec '<json>' [options]
```

**Options:** Same as `vector run`.

### `llm-adapter vector embed`

Embed texts and optionally upsert to a vector store.

```bash
llm-adapter vector embed --spec '<json>' [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-s, --spec <json>` | Spec as JSON string |
| `-f, --file <path>` | Path to spec JSON file |
| `-p, --plugins <path>` | Path to plugins directory |
| `--batch-id <id>` | Batch identifier |
| `--pretty` | Pretty print output |
| `--stream` | Stream progress events |

**Examples:**

```bash
# Embed texts
llm-adapter vector embed --spec '{
  "operation": "embed",
  "store": "memory",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"texts": ["Hello world", "Machine learning is fascinating"]}
}'

# Embed with custom batch size
llm-adapter vector embed --spec '{
  "operation": "embed",
  "store": "memory",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"texts": ["Text 1", "Text 2", "Text 3", "Text 4", "Text 5"]},
  "settings": {"batchSize": 2}
}'

# Stream progress for large batches
llm-adapter vector embed --stream --spec '{
  "operation": "embed",
  "store": "memory",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"texts": ["Text 1", "Text 2", "Text 3", "Text 4", "Text 5"]}
}'
```

### `llm-adapter vector query`

Query a vector store.

```bash
llm-adapter vector query --spec '<json>' [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-s, --spec <json>` | Spec as JSON string |
| `-f, --file <path>` | Path to spec JSON file |
| `-p, --plugins <path>` | Path to plugins directory |
| `--batch-id <id>` | Batch identifier |
| `--pretty` | Pretty print output |

**Examples:**

```bash
# Query with text (auto-embedded)
llm-adapter vector query --spec '{
  "operation": "query",
  "store": "memory",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"query": "What is machine learning?", "topK": 5}
}'

# Query with pre-computed vector
llm-adapter vector query --spec '{
  "operation": "query",
  "store": "memory",
  "input": {"vector": [0.1, 0.2, 0.3], "topK": 5}
}'

# Query with metadata filter
llm-adapter vector query --spec '{
  "operation": "query",
  "store": "memory",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {
    "query": "What is ML?",
    "topK": 10,
    "filter": {"category": "tech"}
  }
}'

# Query specific collection
llm-adapter vector query --spec '{
  "operation": "query",
  "store": "memory",
  "collection": "my-docs",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"query": "search terms", "topK": 5}
}'
```

### `llm-adapter vector upsert`

Upsert pre-computed vectors to a store.

```bash
llm-adapter vector upsert --spec '<json>' [options]
```

**Options:** Same as `vector query`.

**Example:**

```bash
llm-adapter vector upsert --spec '{
  "operation": "upsert",
  "store": "memory",
  "input": {
    "points": [
      {"id": "doc1", "vector": [0.1, 0.2, 0.3], "payload": {"text": "Hello"}},
      {"id": "doc2", "vector": [0.4, 0.5, 0.6], "payload": {"text": "World"}}
    ]
  }
}'
```

### `llm-adapter vector delete`

Delete vectors by ID.

```bash
llm-adapter vector delete --spec '<json>' [options]
```

**Options:** Same as `vector query`.

**Example:**

```bash
llm-adapter vector delete --spec '{
  "operation": "delete",
  "store": "memory",
  "input": {"ids": ["doc1", "doc2"]}
}'
```

### `llm-adapter vector collections`

Manage collections (list, create, delete, check existence).

```bash
llm-adapter vector collections --spec '<json>' [options]
```

**Options:** Same as `vector query`.

**Examples:**

```bash
# List collections
llm-adapter vector collections --spec '{
  "operation": "collections",
  "store": "memory",
  "input": {"collectionOp": "list"}
}'

# Check if collection exists
llm-adapter vector collections --spec '{
  "operation": "collections",
  "store": "memory",
  "input": {"collectionOp": "exists", "collection": "my-docs"}
}'

# Create collection
llm-adapter vector collections --spec '{
  "operation": "collections",
  "store": "memory",
  "input": {
    "collectionOp": "create",
    "collection": "my-docs",
    "dimensions": 1536,
    "options": {"distance": "Cosine"}
  }
}'

# Delete collection
llm-adapter vector collections --spec '{
  "operation": "collections",
  "store": "memory",
  "input": {"collectionOp": "delete", "collection": "my-docs"}
}'
```

---

## Embeddings Commands

### `llm-adapter embeddings run`

Execute an embedding operation.

```bash
llm-adapter embeddings run --spec '<json>' [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-s, --spec <json>` | Spec as JSON string |
| `-f, --file <path>` | Path to spec JSON file |
| `-p, --plugins <path>` | Path to plugins directory |
| `--batch-id <id>` | Batch identifier |
| `--pretty` | Pretty print output |

**Examples:**

```bash
# Embed single text
llm-adapter embeddings run --spec '{
  "operation": "embed",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"text": "Hello world"}
}'

# Embed multiple texts
llm-adapter embeddings run --spec '{
  "operation": "embed",
  "embeddingPriority": [{"provider": "example-embeddings"}],
  "input": {"texts": ["Hello", "World"]}
}'
```

---

## Server Command

### `llm-adapter serve`

Start the HTTP/SSE server. See [README-SERVER.md](README-SERVER.md) for complete server documentation.

```bash
llm-adapter serve [options]
```

**Common Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--host <host>` | Host to bind | `127.0.0.1` |
| `--port <port>` | Port to bind (0 = ephemeral) | `0` |
| `-p, --plugins <path>` | Path to plugins directory | `./plugins` |
| `--batch-id <id>` | Batch identifier | |

**Example:**

```bash
llm-adapter serve --port 3000
```

---

## Realtime Command

### `llm-adapter realtime`

Run a realtime session over a newline-delimited JSON protocol on stdin/stdout.

```bash
llm-adapter realtime [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --plugins <path>` | Path to plugins directory | `./plugins` |

**Input messages (stdin):**

- `open`: `{ "type": "open", "protocolVersion": 1, "spec": { ... } }`
- `send_text`: `{ "type": "send_text", "text": "…", "role": "system" | "user" }`
- `send_audio`: `{ "type": "send_audio", "frame": { "format": "…", "sampleRateHz": 24000, "channels": 1, "dataBase64": "…", "timestampMs": 0 } }`
- `commit`: `{ "type": "commit" }`
- `interrupt`: `{ "type": "interrupt", "reason": "…" }`
- `close`: `{ "type": "close" }`

**Output envelopes (stdout):**

- Events: `{ "type": "event", "event": { ... } }`
- Errors: `{ "type": "error", "error": { "message": "…", "code": "…" } }`

**Contract notes:**

- The first emitted event must be `{ "type": "ready", ... }`.
- The `spec` field is passed through to the realtime session factory and is treated as an opaque object by the CLI.

### `llm-adapter realtime client-secret`

Mint a short-lived realtime **WebRTC client secret** (for browser/mobile WebRTC session establishment).

```bash
llm-adapter realtime client-secret [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-f, --file <path>` | Path to request JSON file | |
| `-s, --spec <json>` | Request as JSON string | |
| `-p, --plugins <path>` | Path to plugins directory | `./plugins` |
| `--pretty` | Pretty print output | |

**Request JSON (file/spec/stdin):**

```json
{
  "provider": "…",
  "model": "…",
  "systemPrompt": "…",
  "expiresAfterSeconds": 60
}
```

Notes:
- `provider` must be a realtime provider id from `plugins/realtime-providers/*.json`.
- `expiresAfterSeconds` (when provided) must be an integer between `30` and `600` (inclusive), matching the server endpoint validation.

**Response (stdout):**

```json
{
  "clientSecret": "…",
  "expiresAt": 1730000000
}
```

---

## Spec Reference

### LLMCallSpec

The specification for LLM calls (`run` and `stream` commands).

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

  // Provider priority list (required) - tries in order until success
  "llmPriority": [
    {
      "provider": "example-llm",
      "model": "example-model",
      "settings": {}  // Optional per-provider settings override
    },
    {
      "provider": "example-llm-2",
      "model": "example-model-2"
    }
  ],

  // Settings (required, can be empty object)
  "settings": {
    "temperature": 0.7,
    "topP": 1.0,
    "maxTokens": 4096,
    "stop": ["END"],
    "seed": 42,
    "frequencyPenalty": 0,
    "presencePenalty": 0,

    // Extended thinking/reasoning
    "reasoning": {
      "enabled": true,
      "effort": "medium",
      "budget": 10000,
      "exclude": false
    },

    // Tool settings
    "maxToolIterations": 10,
    "toolCountdownEnabled": true,
    "toolFinalPromptEnabled": true,
    "parallelToolExecution": false,
    "preserveToolResults": 3,
    "preserveReasoning": 3,
    "toolResultMaxChars": 50000,

    // Optional usage cost calculation (when provider omits cost)
    "usageCost": false
  },

  // Tools (optional)
  "functionToolNames": ["test.echo", "test.random"],
  "tools": [
    {
      "name": "custom_tool",
      "description": "A custom tool",
      "parametersJsonSchema": {
        "type": "object",
        "properties": {
          "param": {"type": "string"}
        }
      }
    }
  ],
  "mcpServers": ["testmcp"],
  "toolChoice": "auto",

  // Vector/RAG (optional)
  "vectorContext": {
    "stores": ["memory"],
    "mode": "auto",
    "topK": 5,
    "embeddingPriority": [{"provider": "example-embeddings"}]
  },

  // Retry configuration (optional)
  "rateLimitRetryDelays": [1, 2, 5, 10],

  // Metadata for logging (optional)
  "metadata": {
    "correlationId": "request-123",
    "userId": "user-456"
  }
}
```

### Usage Cost Calculation

When a provider response omits cost, set `settings.usageCost` to opt into local cost calculation.
Costs are loaded from `plugins/configs/usage-costs.json` and are defined per provider/model in
**cost-per-million tokens**.

### Message Content Types

#### Text Content

```json
{"type": "text", "text": "Hello, world!"}
```

#### Image Content

```json
{
  "type": "image",
  "source": {"type": "base64", "data": "..."},
  "mimeType": "image/png"
}
```

Or from URL:

```json
{
  "type": "image",
  "source": {"type": "url", "url": "https://example.com/image.png"}
}
```

#### Document Content

From file path (recommended):

```json
{
  "type": "document",
  "source": {"type": "filepath", "path": "/path/to/document.pdf"}
}
```

From base64:

```json
{
  "type": "document",
  "source": {"type": "base64", "data": "..."},
  "mimeType": "application/pdf",
  "filename": "document.pdf"
}
```

From URL:

```json
{
  "type": "document",
  "source": {"type": "url", "url": "https://example.com/doc.pdf"},
  "mimeType": "application/pdf"
}
```

From provider file ID:

```json
{
  "type": "document",
  "source": {"type": "file_id", "fileId": "file-abc123"},
  "mimeType": "application/pdf"
}
```

**Supported Document Types:**

| Extension | MIME Type |
|-----------|-----------|
| .pdf | application/pdf |
| .csv | text/csv |
| .txt | text/plain |
| .json | application/json |
| .html, .htm | text/html |
| .md, .markdown | text/markdown |
| .docx | application/vnd.openxmlformats-officedocument.wordprocessingml.document |
| .xlsx | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet |

### VectorCallSpec

The specification for vector operations.

```typescript
{
  // Operation type (required)
  "operation": "embed" | "upsert" | "query" | "delete" | "collections",

  // Vector store ID (required)
  "store": "memory",

  // Collection name (optional, uses store default)
  "collection": "my-collection",

  // Embedding provider priority (required for operations that need embeddings)
  "embeddingPriority": [
    {"provider": "example-embeddings"}
  ],

  // Operation-specific input (required)
  "input": { ... },

  // Operation settings (optional)
  "settings": {
    "batchSize": 10,
    "includePayload": true,
    "includeVector": false
  },

  // Metadata (optional)
  "metadata": {
    "correlationId": "request-123"
  }
}
```

#### Input by Operation

**embed:**
```json
{
  "texts": ["Text to embed", "Another text"],
  "ids": ["id1", "id2"],
  "payloads": [{"meta": "data1"}, {"meta": "data2"}],
  "upsert": true
}
```

**query:**
```json
{
  "query": "Search text",
  "topK": 5,
  "filter": {"category": "tech"},
  "scoreThreshold": 0.7
}
```

Or with pre-computed vector:
```json
{
  "vector": [0.1, 0.2, 0.3],
  "topK": 5
}
```

**upsert:**
```json
{
  "points": [
    {"id": "doc1", "vector": [0.1, 0.2], "payload": {"text": "Hello"}}
  ]
}
```

**delete:**
```json
{
  "ids": ["doc1", "doc2"]
}
```

**collections:**
```json
{
  "collectionOp": "list" | "exists" | "create" | "delete",
  "collection": "collection-name",
  "dimensions": 1536,
  "options": {"distance": "Cosine"}
}
```

### EmbeddingCallSpec

The specification for embedding operations.

```typescript
{
  // Operation (required)
  "operation": "embed",

  // Embedding provider priority (required)
  "embeddingPriority": [
    {"provider": "example-embeddings"}
  ],

  // Input (required)
  "input": {
    "text": "Single text to embed"
  }
  // OR
  "input": {
    "texts": ["Multiple", "texts", "to embed"]
  },

  // Metadata (optional)
  "metadata": {
    "correlationId": "request-123"
  }
}
```

---

## VectorContextConfig (RAG Integration)

When using LLM calls with vector stores for RAG:

```typescript
{
  "messages": [...],
  "llmPriority": [...],
  "settings": {},
  "vectorContext": {
    // Which stores to query (required)
    "stores": ["memory"],

    // Mode (required)
    "mode": "auto" | "tool" | "both",

    // Query config
    "topK": 5,
    "scoreThreshold": 0.7,
    "filter": {"category": "tech"},
    "collection": "my-docs",
    "embeddingPriority": [{"provider": "example-embeddings"}],

    // Query construction (auto/both modes)
    "overrideEmbeddingQuery": "exact query to use",
    "queryConstruction": {
      "messagesToInclude": 1,
      "includeAssistantMessages": true,
      "includeSystemPrompt": "if-in-range"
    },

    // Auto-inject config (auto/both modes)
    "injectAs": "system" | "user_context",
    "injectTemplate": "Relevant context:\n{{results}}",
    "resultFormat": "- {{payload.text}} (score: {{score}})",
    "maxContextTokens": 4000,

    // Tool mode config (tool/both modes)
    "toolName": "vector_search",
    "toolDescription": "Search the knowledge base",
    "toolSchemaOverrides": {
      "toolDescription": "Search product docs",
      "params": {
        "query": {"name": "search_query", "description": "Your search"},
        "topK": {"name": "limit", "description": "Max results"}
      }
    },

    // Parameter locking (tool mode only)
    "locks": {
      "store": "memory",
      "topK": 5,
      "filter": {"tenant": "acme"},
      "scoreThreshold": 0.7,
      "collection": "docs"
    }
  }
}
```

### Mode Descriptions

| Mode | Behavior |
|------|----------|
| `auto` | Query vectors using user message, inject results before LLM call |
| `tool` | Create a `vector_search` tool the LLM can call on-demand |
| `both` | Auto-inject initial context + provide tool for follow-up queries |

---

## Per-Provider Settings

Override settings for specific providers:

```json
{
  "messages": [...],
  "llmPriority": [
    {
      "provider": "example-llm",
      "model": "example-model",
      "settings": {
        "temperature": 0.3,
        "reasoning": {"enabled": true, "budget": 5000}
      }
    },
    {
      "provider": "example-llm-2",
      "model": "example-model-2"
    }
  ],
  "settings": {
    "temperature": 0.7,
    "maxTokens": 4096
  }
}
```

The first priority item gets `{temperature: 0.3, maxTokens: 4096, reasoning: {enabled: true, budget: 5000}}`.
The default settings apply to all items unless overridden.

---

## Tool Configuration

### Using Plugin Tools

Reference tools defined in `plugins/tools/*.json`:

```json
{
  "messages": [...],
  "llmPriority": [...],
  "settings": {},
  "functionToolNames": ["test.echo", "test.random"]
}
```

### Inline Tool Definitions

Define tools directly in the spec:

```json
{
  "messages": [...],
  "llmPriority": [...],
  "settings": {},
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather for a location",
      "parametersJsonSchema": {
        "type": "object",
        "properties": {
          "location": {
            "type": "string",
            "description": "City name"
          },
          "unit": {
            "type": "string",
            "enum": ["celsius", "fahrenheit"],
            "description": "Temperature unit"
          }
        },
        "required": ["location"]
      }
    }
  ]
}
```

### MCP Servers

Use MCP server tools:

```json
{
  "messages": [...],
  "llmPriority": [...],
  "settings": {},
  "mcpServers": ["testmcp"]
}
```

### Tool Choice

Control tool selection:

```json
{
  "toolChoice": "auto"
}
```

| Value | Behavior |
|-------|----------|
| `"auto"` | Model decides when to use tools |
| `"required"` | Model must use a tool |
| `"none"` | Model cannot use tools |
| `{"type": "tool", "name": "tool_name"}` | Force specific tool |

---

## Using Spec Files

Instead of inline JSON, use spec files:

```bash
# Create spec file
cat > my-spec.json << 'EOF'
{
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "Hello"}]}
  ],
  "llmPriority": [
    {"provider": "example-llm", "model": "example-model"}
  ],
  "settings": {}
}
EOF

# Use spec file
llm-adapter run --file my-spec.json
llm-adapter stream --file my-spec.json
```

---

## Environment Variables

### Logging

| Variable | Purpose | Values |
|----------|---------|--------|
| `LLM_ADAPTER_BATCH_ID` | Batch identifier for logs | string |
| `LLM_ADAPTER_BATCH_DIR` | Use batch-based directories | "1" or "0" |
| `LLM_ADAPTER_DISABLE_FILE_LOGS` | Disable file logging | "1" or unset |
| `LLM_ADAPTER_DISABLE_CONSOLE_LOGS` | Disable console logging | "1" or unset |

### Provider API Keys

Set in your environment or `.env` file:

```bash
export LLM_API_KEY=...
export EMBEDDINGS_API_KEY=...
export VECTOR_STORE_API_KEY=...
```

### Observability (Optional)

For LLM call telemetry export to Langfuse:

```bash
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_PUBLIC_KEY=pk-lf-...
```

Enable observability in your spec:

```json
{
  "observability": {
    "enabled": true,
    "provider": "langfuse"
  }
}
```

Tip: set `metadata.correlationId` (trace name) and `metadata.tags` (tags) for stable naming/grouping.

Or globally via `plugins/configs/defaults.json`.

---

## Output Formats

### Non-Streaming Response

```json
{
  "type": "response",
  "data": {
    "content": [{"type": "text", "text": "Response text"}],
    "stopReason": "end_turn",
    "usage": {
      "inputTokens": 10,
      "outputTokens": 50
    },
    "model": "example-model",
    "provider": "example-llm"
  }
}
```

### Streaming Events

Each event is a JSON object:

```json
{"type": "message_start", ...}
{"type": "delta", "text": "Hello"}
{"type": "delta", "text": " world"}
{"type": "tool_use", "name": "test.echo", "input": {...}}
{"type": "tool_result", "toolCallId": "...", "result": {...}}
{"type": "message_stop", ...}
```

### Vector Operation Results

**Query:**
```json
{
  "type": "response",
  "data": {
    "operation": "query",
    "results": [
      {"id": "doc1", "score": 0.95, "payload": {"text": "..."}},
      {"id": "doc2", "score": 0.87, "payload": {"text": "..."}}
    ]
  }
}
```

**Embed:**
```json
{
  "type": "response",
  "data": {
    "operation": "embed",
    "vectors": [[0.1, 0.2, ...], [0.3, 0.4, ...]],
    "dimensions": 1536
  }
}
```

---

## Examples

### Simple Chat

```bash
llm-adapter run --spec '{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "What is 2+2?"}]}],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {}
}'
```

### Multi-Turn Conversation

```bash
llm-adapter run --spec '{
  "systemPrompt": "You are a math tutor.",
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "What is calculus?"}]},
    {"role": "assistant", "content": [{"type": "text", "text": "Calculus is..."}]},
    {"role": "user", "content": [{"type": "text", "text": "Can you give an example?"}]}
  ],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {"temperature": 0.5}
}'
```

### With Document

```bash
llm-adapter run --spec '{
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Summarize this document"},
        {"type": "document", "source": {"type": "filepath", "path": "/path/to/doc.pdf"}}
      ]
    }
  ],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {}
}'
```

### With Tool Calls

```bash
llm-adapter run --spec '{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "Echo hello"}]}],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {},
  "functionToolNames": ["test.echo"]
}'
```

### RAG with Auto-Inject

```bash
llm-adapter run --spec '{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "What is machine learning?"}]}],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {},
  "vectorContext": {
    "stores": ["memory"],
    "mode": "auto",
    "topK": 5,
    "embeddingPriority": [{"provider": "example-embeddings"}],
    "injectAs": "system",
    "injectTemplate": "Use this context to answer:\n{{results}}"
  }
}'
```

### RAG with Tool Mode

```bash
llm-adapter run --spec '{
  "systemPrompt": "You can search the knowledge base when needed.",
  "messages": [{"role": "user", "content": [{"type": "text", "text": "Find info about neural networks"}]}],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {},
  "vectorContext": {
    "stores": ["memory"],
    "mode": "tool",
    "toolName": "search_knowledge_base",
    "toolDescription": "Search the knowledge base for relevant information",
    "embeddingPriority": [{"provider": "example-embeddings"}]
  }
}'
```

### Provider Fallback

```bash
llm-adapter run --spec '{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}],
  "llmPriority": [
    {"provider": "example-llm", "model": "example-model"},
    {"provider": "example-llm-2", "model": "example-model-2"},
    {"provider": "example-llm-3", "model": "example-model-3"}
  ],
  "settings": {}
}'
```

### Extended Thinking

```bash
llm-adapter run --spec '{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "Solve this complex problem..."}]}],
  "llmPriority": [{"provider": "example-llm", "model": "example-model"}],
  "settings": {
    "reasoning": {
      "enabled": true,
      "effort": "high",
      "budget": 20000
    }
  }
}'
```
