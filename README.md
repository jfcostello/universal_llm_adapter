# LLM Adapter

Provider-agnostic LLM adapter with a unified interface across multiple providers via a plugin architecture. Supports text, images, documents, tool calls, MCP, and vector stores.

## Features

- **Plugin-Based Providers**: Add/remove providers via `plugins/` manifests + compats
- **Per-Provider Settings**: Configure different settings (temperature, maxTokens, etc.) for each provider in your priority list
- **Document Processing**: Universal file support with automatic format detection and conversion
- **Tool Calling**: Unified tool calling interface across providers
- **MCP Integration**: Model Context Protocol server support
- **Vector Stores**: Integration with vector databases for RAG applications
- **Streaming**: Real-time streaming responses with tool support
- **Realtime Sessions**: Bidirectional sessions (audio/text in, audio/transcripts/tools out) via `llm-adapter/realtime`
- **Observability**: Optional LLM call telemetry export to platforms like Langfuse
- **100% Test Coverage**: Comprehensive test suite with full coverage

## Quick Start

```bash
# CLI usage
llm-adapter run --spec '{"messages":[...],"llmPriority":[...],"settings":{}}'

# Server usage
llm-adapter serve --port 3000
```

See [README-CLI.md](README-CLI.md) for complete CLI documentation and [README-SERVER.md](README-SERVER.md) for server documentation.

## Architecture

```
universal_llm_adapter/
├── bin/
│   └── cli.ts                    # CLI entry point (thin shell, lazy-loads modules)
├── modules/                      # Provider-agnostic core logic
│   ├── kernel/                   # Core primitives: types, defaults, registry, config
│   ├── cli/                      # Unified CLI program and handlers
│   ├── llm/                      # LLM coordinator and manager
│   ├── realtime/                 # Realtime session entrypoint + controller
│   ├── server/                   # HTTP/SSE server
│   ├── vector/                   # Vector store coordinator and manager
│   ├── embeddings/               # Embedding coordinator and manager
│   ├── tools/                    # Tool discovery and execution loop
│   ├── mcp/                      # MCP client and server management
│   ├── messages/                 # Message preparation and mutation
│   ├── context/                  # Conversation pruning and token estimation
│   ├── documents/                # Document loading and preprocessing
│   ├── logging/                  # Logger factories (LLM, Embedding, Vector)
│   ├── security/                 # Security utilities, header redaction
│   ├── settings/                 # Settings splitting and merging
│   ├── shared/                   # Small shared utilities (lazy-loaded)
│   ├── retry/                    # Retry policies and sequencing
│   ├── usage/                    # Usage/cost metadata normalization
│   ├── usage-cost/               # Optional usage cost calculation
│   ├── lifecycle/                # Coordinator lifecycle wrappers
│   ├── observability/            # LLM call telemetry export
│   └── string/                   # String utilities
├── plugins/                      # Provider-specific implementations
│   ├── providers/                # LLM provider configs (.json)
│   ├── realtime-providers/       # Realtime provider configs (.json)
│   ├── embeddings/               # Embedding provider configs (.json)
│   ├── vector/                   # Vector store configs (.json)
│   ├── compat/                   # LLM provider compat implementations
│   ├── realtime-compat/          # Realtime provider compat implementations
│   ├── embedding-compat/         # Embedding provider compat implementations
│   ├── vector-compat/            # Vector store compat implementations
│   ├── observability-providers/  # Observability provider configs (.json)
│   ├── observability-compat/     # Observability compat implementations
│   ├── tools/                    # Tool definitions (.json)
│   ├── processes/                # Process routing configs (.json)
│   ├── mcp/                      # MCP server configs (.json)
│   ├── mcp-servers/              # MCP server implementations (.mjs)
│   ├── modules/                  # Plugin modules for tools
│   └── configs/
│       ├── defaults.json         # Centralized defaults
│       └── usage-costs.json      # Usage cost table (per provider/model)
├── tests/
│   ├── live/                     # Live integration tests
│   └── sandbox/                  # Ad-hoc CLI runner
└── package.json
```

### Key Principles

1. **Plugin-First Design**: All provider-specific logic lives in `plugins/`. Core modules remain provider-agnostic.

2. **Lazy Loading**: CLI/server only load modules when needed (e.g., `--help` loads only commander, not providers).

3. **Strict Module Boundaries**: Each module has clear exports via `index.ts`. Internals are private.

4. **Index-Only Imports**: Production code imports from `module/index.ts`, never from `internal/`.

## Plugin System

### LLM Providers

Provider configurations live in `plugins/providers/*.json`:

```json
{
  "id": "example-llm",
  "compat": "example-llm",
  "endpoint": {
    "urlTemplate": "https://example.com/v1/messages",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer ${LLM_API_KEY}",
      "X-Example-Version": "2025-01-01"
    }
  },
  "retryWords": ["rate", "limit", "overloaded"],
  "defaults": {
    "maxTokens": 8192,
    "reasoningBudget": 51200
  }
}
```

Provider compat implementations live in `plugins/compat/<provider>/index.ts` and implement `ICompatModule`:
- `buildPayload()` - Transform unified spec to provider format
- `parseResponse()` - Transform provider response to unified format
- `parseStreamChunk()` - Parse streaming chunks
- `getStreamingFlags()` - Return provider streaming flags
- `serializeTools()` - Serialize unified tools
- `serializeToolChoice()` - Serialize tool choice
- `applyProviderExtensions()` - Apply provider payload extensions (optional)
- `callSDK()` / `streamSDK()` - Optional SDK-based overrides (when available)

### Realtime Providers

Realtime provider configurations live in `plugins/realtime-providers/*.json` and are intentionally separate from LLM providers.

```json
{
  "id": "example-realtime",
  "compat": "example-realtime",
  "endpoint": {
    "urlTemplate": "wss://example.com/realtime?model={model}",
    "headers": {
      "Authorization": "Bearer ${REALTIME_API_KEY}"
    }
  }
}
```

Realtime compat implementations live in `plugins/realtime-compat/<kind>/index.ts` and implement `IRealtimeCompat`.

### Compat templates

Compats are intentionally thin translation layers. Their `internal/` code is split by concern and treated as private to the plugin directory.

- **A layout (default)**: `internal/<compat>.ts` (orchestration) + `messages.ts`, `settings.ts`, `tools.ts`, `response.ts`, `stream.ts`, `mappings.ts` (and `extensions.ts` only when needed).
- **B layout (large vector stores)**: `internal/<compat>.ts` (orchestration) + `internal/{client,ids,filters,operations}/**` to keep concerns isolated.

Provider-agnostic extraction/normalization (usage, tool results, safe parsing, vector math, etc.) lives in `modules/**` and is shared by all compats.

### Embedding Providers

Embedding configurations live in `plugins/embeddings/*.json`:

```json
{
  "id": "example-embeddings",
  "kind": "example-embeddings",
  "endpoint": {
    "urlTemplate": "https://example.com/v1/embeddings",
    "headers": {
      "Authorization": "Bearer ${EMBEDDINGS_API_KEY}"
    }
  },
  "model": "example/embedding-model",
  "dimensions": 1536
}
```

Embedding compat implementations live in `plugins/embedding-compat/<kind>/index.ts`.

### Vector Stores

Vector store configurations live in `plugins/vector/*.json`:

```json
{
  "id": "memory-local",
  "kind": "memory",
  "defaultEmbeddingPriority": [{ "provider": "example-embeddings" }],
  "defaultCollection": "documents"
}
```

Vector compat implementations live in `plugins/vector-compat/<kind>/index.ts`.

### Tools

Tool definitions live in `plugins/tools/*.json`:

```json
{
  "name": "test.echo",
  "description": "Echo back a message exactly as provided",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string", "description": "The message to echo" }
    },
    "required": ["message"]
  }
}
```

Process routing (how tools are invoked) lives in `plugins/processes/*.json`:

```json
{
  "id": "test-echo",
  "match": { "type": "exact", "pattern": "test.echo" },
  "invoke": {
    "kind": "module",
    "module": "./dist/plugins/modules/test-echo/index.js",
    "function": "handle"
  },
  "timeoutMs": 5000
}
```

### MCP Servers

MCP server configurations live in `plugins/mcp/*.json`:

```json
{
  "mcpServers": {
    "testmcp": {
      "command": "node",
      "args": ["./plugins/mcp-servers/test-server.mjs"],
      "description": "Test MCP server",
      "autoStart": false
    }
  }
}
```

### Observability (Optional)

Observability enables export of LLM call telemetry to platforms like Langfuse. It is disabled by default.

**Global Configuration** (`plugins/configs/defaults.json`):

```json
{
  "observability": {
    "enabled": true,
    "provider": "langfuse"
  }
}
```

**Per-Call Override** (`spec.observability`):

```typescript
{
  observability: {
    enabled: true,
    provider: 'langfuse',
    traceId: 'custom-trace-id',    // Optional
    sessionId: 'session-abc'        // Optional
  }
}
```

**Tip:** For stable naming/grouping, set:
- `spec.metadata.correlationId` (used as the Langfuse trace name when using the Langfuse provider)
- `spec.metadata.tags` (forwarded as Langfuse tags when present)

**Required Environment Variables** (for Langfuse):
- `LANGFUSE_SECRET_KEY` - Langfuse secret key
- `LANGFUSE_PUBLIC_KEY` - Langfuse public key

Observability is non-blocking: if export fails, LLM calls still succeed. See `modules/observability/README.md` for full documentation.

## Core Types

### LLMCallSpec

The unified specification for LLM calls:

```typescript
interface LLMCallSpec {
  systemPrompt?: string;
  messages: Message[];
  llmPriority: LLMPriorityItem[];
  settings: LLMCallSettings;

  // Tools
  functionToolNames?: string[];
  tools?: UnifiedTool[];
  mcpServers?: string[];
  toolChoice?: ToolChoice;

  // Vector/RAG
  vectorContext?: VectorContextConfig;
  vectorPriority?: string[];

  // Retry
  rateLimitRetryDelays?: number[];

  // Observability
  observability?: ObservabilitySpec;

  // Metadata
  metadata?: JsonObject;
}
```

### Message Structure

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: ReasoningData;
}

type ContentPart = TextContent | ImageContent | DocumentContent | ToolResultContent;

interface DocumentContent {
  type: 'document';
  source:
    | { type: 'filepath'; path: string }
    | { type: 'base64'; data: string }
    | { type: 'url'; url: string }
    | { type: 'file_id'; fileId: string };
  mimeType?: string;
  filename?: string;
  providerOptions?: Record<string, any>;
}
```

### LLMCallSettings

```typescript
interface LLMCallSettings {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: string;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;

  // Extended thinking/reasoning
  reasoning?: {
    enabled?: boolean;
    effort?: 'high' | 'medium' | 'low' | 'minimal' | 'none' | 'xhigh';
    budget?: number;
    exclude?: boolean;
  };
  reasoningBudget?: number;

  // Tool configuration
  toolCountdownEnabled?: boolean;
  toolFinalPromptEnabled?: boolean;
  maxToolIterations?: number;
  preserveToolResults?: number | 'all' | 'none';
  preserveReasoning?: number | 'all' | 'none';
  parallelToolExecution?: boolean;
  toolResultMaxChars?: number;

  // Provider-specific
  provider?: Record<string, any>;
}
```

### VectorCallSpec

```typescript
interface VectorCallSpec {
  operation: 'embed' | 'upsert' | 'query' | 'delete' | 'collections';
  store: string;
  collection?: string;
  embeddingPriority?: EmbeddingPriorityItem[];
  input?: VectorOperationInput;
  settings?: VectorOperationSettings;
  metadata?: JsonObject;
}
```

### EmbeddingCallSpec

```typescript
interface EmbeddingCallSpec {
  operation: string;
  provider?: string;
  model?: string;
  embeddingPriority?: EmbeddingPriorityItem[];
  input?: { text?: string; texts?: string[] };
  metadata?: JsonObject;
}
```

## Configuration

### Centralized Defaults

All non-provider-specific defaults are in `plugins/configs/defaults.json`:

```json
{
  "retry": {
    "maxAttempts": 3,
    "baseDelayMs": 250,
    "multiplier": 2.0,
    "rateLimitDelays": [1, 1, 5, 5, 5, 15, 15, 16, 30, 31, 61, 5, 5, 51]
  },
  "tools": {
    "countdownEnabled": true,
    "finalPromptEnabled": true,
    "parallelExecution": false,
    "preserveResults": 3,
    "preserveReasoning": 3,
    "maxIterations": 10,
    "timeoutMs": 120000
  },
  "vector": {
    "topK": 5,
    "batchSize": 10,
    "injectTemplate": "Relevant context:\n{{results}}",
    "resultFormat": "- {{payload.text}} (score: {{score}})",
    "defaultCollection": "default"
  },
  "chunking": {
    "size": 500,
    "overlap": 50
  },
  "tokenEstimation": {
    "textDivisor": 4,
    "imageEstimate": 768,
    "toolResultDivisor": 6
  },
  "timeouts": {
    "mcpRequest": 30000,
    "llmHttp": 60000,
    "embeddingHttp": 60000,
    "loggerFlush": 2000
  },
  "server": {
    "maxRequestBytes": 26214400,
    "bodyReadTimeoutMs": 10000,
    "requestTimeoutMs": 0,
    "streamIdleTimeoutMs": 60000,
    "maxConcurrentRequests": 128,
    "maxConcurrentStreams": 32,
    "maxQueueSize": 1000,
    "queueTimeoutMs": 30000
  }
}
```

### Production Limits

For production deployments, be aware of per-process resource limits enforced by the server and realtime modules:

- **Server**: `maxConcurrentRequests`, `maxConcurrentStreams`, `maxQueueSize` (see `plugins/configs/defaults.json`)
- **Realtime WS**: `maxConcurrentSessions`, `maxMessageBytes`, `maxAudioBytesPerSecond`, `idleTimeoutMs`, `maxSessionDurationMs`
- **Twilio Bridge**: `maxPendingInboundFrames`, `maxPendingOutboundAudioMs`, `maxWsMessageBytes`

These limits protect against resource exhaustion. Tune them based on your expected concurrency and available memory.

### Accessing Defaults in Code

```typescript
import { getDefaults } from 'llm-adapter';

const defaults = await getDefaults();
console.log(defaults.retry.maxAttempts);   // 3
console.log(defaults.tools.maxIterations); // 10
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `LLM_ADAPTER_BATCH_ID` | Batch identifier for logs |
| `LLM_ADAPTER_BATCH_DIR` | Use batch-based directories for logs ("1" or "0") |
| `LLM_ADAPTER_DISABLE_FILE_LOGS` | Disable file logging ("1" or unset) |
| `LLM_ADAPTER_DISABLE_CONSOLE_LOGS` | Disable console logging ("1" or unset) |

Provider-specific environment variables are defined in provider manifests with `${ENV_VAR}` syntax:
- `${LLM_API_KEY}`
- `${EMBEDDINGS_API_KEY}`
- `${VECTOR_STORE_API_KEY}`

## Programmatic Usage

### LLM Coordinator

```typescript
import { createRegistry, createLlmCoordinator, closeLogger } from 'llm-adapter';

const registry = await createRegistry('./plugins');
await registry.loadAll?.();
const coordinator = await createLlmCoordinator(registry);

const response = await coordinator.run({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
  ],
  llmPriority: [
    { provider: '...', model: '...' }
  ],
  settings: { temperature: 0.7 }
});

await coordinator.close();
await closeLogger();
```

### Embedding Coordinator

```typescript
import { createRegistry, createEmbeddingCoordinator, closeLogger } from 'llm-adapter';

const registry = await createRegistry('./plugins');
await registry.loadAll?.();
const embeddings = await createEmbeddingCoordinator(registry);

const result = await embeddings.execute({
  operation: 'embed',
  input: { text: 'Hello world' },
  embeddingPriority: [{ provider: '...' }]
});

console.log(result.vectors);    // [[0.1, 0.2, ...]]
console.log(result.dimensions); // 1536

await embeddings.close();
await closeLogger();
```

### Vector Store Coordinator

```typescript
import { createRegistry, createVectorCoordinator, closeLogger } from 'llm-adapter';

const registry = await createRegistry('./plugins');
await registry.loadAll?.();
const vector = await createVectorCoordinator(registry);

const { results } = await vector.execute({
  operation: 'query',
  store: '...',
  input: { query: 'What is machine learning?', topK: 5 },
  embeddingPriority: [{ provider: '...' }]
}) as any;

await vector.close();
await closeLogger();
```

### Server

```typescript
import { createServer } from 'llm-adapter';

const server = await createServer({ port: 3000 });
console.log(server.url);  // http://127.0.0.1:3000

// later
await server.close();
```

## Logging

```typescript
import { getLLMLogger, getEmbeddingLogger, getVectorLogger, closeLogger } from 'llm-adapter/logging';

// Get loggers
const llmLogger = getLLMLogger();
const embeddingLogger = getEmbeddingLogger();
const vectorLogger = getVectorLogger();

// With correlation ID
const logger = getLLMLogger().withCorrelation('request-123');
logger.info('Processing request');

// Close all loggers (call on shutdown)
await closeLogger();
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run live tests (require API keys)
npm run test:live

# Filter live tests by provider id(s)
LLM_TEST_PROVIDERS=provider-a,provider-b npm run test:live
```

### Sandbox (Manual Testing)

```bash
# Scripted scenario
npm run sandbox:cli -- --scenario tests/sandbox/scenarios/example.yml

# Interactive mode
npm run sandbox:cli -- --scenario tests/sandbox/scenarios/interactive-empty.yml
```

## Documentation

- [README-CLI.md](README-CLI.md) - Complete CLI manual with all commands and options
- [README-SERVER.md](README-SERVER.md) - Complete server manual with all endpoints and configuration
- `modules/*/README.md` - Module-specific documentation
- `plugins/*/README.md` - Plugin-specific documentation
