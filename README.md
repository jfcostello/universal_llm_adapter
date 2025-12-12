# LLM Coordinator

Universal LLM adapter providing a unified interface across multiple AI providers (Anthropic, OpenAI, Google Gemini, OpenRouter) with support for text, images, documents, tool calls, MCPs, and vector stores.

## Features

- **Multi-Provider Support**: Seamless integration with Anthropic Claude, OpenAI GPT, Google Gemini, and OpenRouter
- **Per-Provider Settings**: Configure different settings (temperature, maxTokens, etc.) for each provider in your priority list
- **Document Processing**: Universal file support with automatic format detection and conversion
- **Tool Calling**: Unified tool calling interface across providers
- **MCP Integration**: Model Context Protocol server support
- **Vector Stores**: Integration with vector databases for RAG applications
- **Streaming**: Real-time streaming responses with tool support
- **100% Test Coverage**: Comprehensive test suite with full coverage

## Server Mode

The adapter can run as a thin HTTP/SSE server, exposing the same spec‑driven behavior as the CLI.
All LLM logic remains in the coordinator; the server is transport‑only.

### Start via CLI

```bash
llm-coordinator serve [options]
```

Common options:
- `--host <host>` (default `127.0.0.1`)
- `--port <port>` (default `0` for ephemeral)
- `--plugins <path>` (default `./plugins`)
- `--batch-id <id>` (optional)

Operational knobs (all optional; override `server.*` defaults):
- `--max-request-bytes <n>`
- `--body-read-timeout-ms <n>`
- `--request-timeout-ms <n>`
- `--stream-idle-timeout-ms <n>`
- `--max-concurrent-requests <n>`
- `--max-concurrent-streams <n>`
- `--max-queue-size <n>`
- `--queue-timeout-ms <n>`
- `--auth-enabled`, `--no-auth-allow-bearer`, `--no-auth-allow-api-key-header`, `--auth-header-name <name>`, `--auth-realm <realm>`
- `--rate-limit-enabled`, `--rate-limit-requests-per-minute <n>`, `--rate-limit-burst <n>`, `--rate-limit-trust-proxy-headers`
- `--cors-enabled`
- `--no-security-headers-enabled`

**Secrets and allowlists are config/env only.** Do not pass API keys or CORS origin lists via CLI; set them under `server.auth.*` and `server.cors.*` in `plugins/configs/defaults.json` or via `${ENV}` substitution.

### Start programmatically

```ts
import { createServer } from 'llm-adapter';

const server = await createServer({ port: 3000 });
console.log(server.url);

// later
await server.close();
```

This is only for embedding server startup in a Node process; consumers still call the HTTP endpoints.

### Endpoints

- `POST /run`
  - Body: `LLMCallSpec` JSON.
  - Response: `{ "type": "response", "data": <LLMResponse> }`.
- `POST /stream`
  - Body: `LLMCallSpec` JSON.
  - Response: SSE `text/event-stream` where each event is a raw `LLMStreamEvent` framed as `data: <json>\n\n`.

Minimal curl example:

```bash
curl -sS http://127.0.0.1:3000/run \\
  -H "content-type: application/json" \\
  -d '{
    "messages": [{"role":"user","content":[{"type":"text","text":"Hello"}]}],
    "llmPriority": [{"provider":"<provider-id>","model":"<model-id>"}],
    "settings": {}
  }'
```

## Per-Provider Settings

### Overview

When specifying multiple providers in `llmPriority`, you can configure different settings for each provider. This is useful when:
- Different providers perform better with different temperature values
- You want to use extended thinking (reasoning) only with providers that support it
- You need different token limits for different models

### Usage

#### Global Settings Only (Default)

Settings apply to all providers in the priority list:

```typescript
const response = await coordinator.run({
  messages: [...],
  llmPriority: [
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
    { provider: 'openai', model: 'gpt-4o' }
  ],
  settings: {
    temperature: 0.7,
    maxTokens: 1000
  }
});
// Both providers use temperature: 0.7, maxTokens: 1000
```

#### Per-Provider Settings

Add a `settings` field to individual priority items:

```typescript
const response = await coordinator.run({
  messages: [...],
  llmPriority: [
    {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      settings: { temperature: 0.3 }  // Override for Anthropic
    },
    {
      provider: 'openai',
      model: 'gpt-4o'
      // No override - uses global settings
    }
  ],
  settings: {
    temperature: 0.7,
    maxTokens: 1000
  }
});
// Anthropic gets: { temperature: 0.3, maxTokens: 1000 }
// OpenAI gets: { temperature: 0.7, maxTokens: 1000 }
```

### Merge Behavior

Per-provider settings use **deep merge** with global settings:

- **Primitives**: Per-provider value overrides global
- **Nested objects**: Deep merged (e.g., `reasoning` object)
- **Arrays**: Replaced entirely (e.g., `stop` sequences)
- **Undefined values**: Ignored (falls back to global)

#### Deep Merge Example

```typescript
{
  llmPriority: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      settings: {
        reasoning: { budget: 2000 }  // Override only budget
      }
    }
  ],
  settings: {
    temperature: 0.7,
    reasoning: { enabled: true, budget: 1000 }
  }
}
// Anthropic gets: {
//   temperature: 0.7,
//   reasoning: { enabled: true, budget: 2000 }  // enabled preserved, budget overridden
// }
```

### Tool Loop Propagation

Per-provider settings automatically propagate to tool loop follow-up calls. If a provider makes multiple LLM calls during tool execution, all calls use the same merged settings.

## File Support

### Overview

The LLM coordinator supports sending files (PDFs, CSVs, text files, images, etc.) to any compatible provider. Files are automatically preprocessed and converted to the appropriate format for each provider.

### Supported File Types

- **Documents**: PDF, CSV, TXT, JSON, HTML, Markdown
- **Microsoft Office**: DOCX, XLSX
- **Images**: JPEG, PNG, GIF, WebP (as ImageContent, not DocumentContent)
- **Custom**: Any file type with MIME type specification

### Usage

#### Filepath Sources (Recommended)

Provide a file path and the coordinator will automatically load, encode, and detect the MIME type:

```typescript
import { LLMCoordinator } from './llm_coordinator';
import { Role } from './core/types';

const coordinator = new LLMCoordinator();

const response = await coordinator.run({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Analyze this document' },
        {
          type: 'document',
          source: { type: 'filepath', path: '/path/to/document.pdf' }
          // mimeType and filename are auto-detected
        }
      ]
    }
  ],
  llmPriority: [
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
  ]
});
```

#### Base64 Sources

For pre-encoded data:

```typescript
{
  type: 'document',
  source: { type: 'base64', data: 'dGVzdCBkYXRh...' },
  mimeType: 'application/pdf',  // Required for base64
  filename: 'report.pdf'         // Optional
}
```

#### URL Sources

For publicly accessible files:

```typescript
{
  type: 'document',
  source: { type: 'url', url: 'https://example.com/doc.pdf' },
  mimeType: 'application/pdf',  // Required
  filename: 'doc.pdf'            // Optional
}
```

**Note**: URL support varies by provider:
- ✅ Anthropic: Supported
- ✅ Google Gemini: Supported (gs:// URLs for Google Cloud Storage)
- ✅ OpenAI Responses API: Supported
- ❌ OpenAI Chat Completions: Not supported (use base64 or file_id instead)

#### File ID Sources

For provider-uploaded files:

```typescript
{
  type: 'document',
  source: { type: 'file_id', fileId: 'file-abc123' },
  mimeType: 'application/pdf',  // Required
  filename: 'doc.pdf'            // Optional
}
```

### Provider-Specific Options

#### Anthropic Cache Control

Enable prompt caching for large documents:

```typescript
{
  type: 'document',
  source: { type: 'filepath', path: '/path/to/large-doc.pdf' },
  providerOptions: {
    anthropic: {
      cacheControl: { type: 'ephemeral' }
    }
  }
}
```

#### OpenRouter Plugins

Use OpenRouter's document processing plugins:

```typescript
{
  type: 'document',
  source: { type: 'filepath', path: '/path/to/document.pdf' },
  providerOptions: {
    openrouter: {
      plugin: 'pdf-text'  // or 'mistral-ocr' or 'native'
    }
  }
}
```

### Implementation Details

#### Automatic Preprocessing

The coordinator automatically:
1. Loads files from filesystem paths
2. Detects MIME types from file extensions
3. Encodes binary data to base64
4. Extracts filenames from paths
5. Converts to provider-specific formats

#### Provider Format Transformations

**Anthropic**:
```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "..."
  }
}
```

**OpenAI Chat Completions**:
```json
{
  "type": "file",
  "file": {
    "filename": "doc.pdf",
    "file_data": "data:application/pdf;base64,..."
  }
}
```

**Google Gemini** (base64):
```json
{
  "inlineData": {
    "mimeType": "application/pdf",
    "data": "..."
  }
}
```

**Google Gemini** (URLs/file IDs):
```json
{
  "fileData": {
    "fileUri": "gs://bucket/file.pdf",
    "mimeType": "application/pdf"
  }
}
```

#### MIME Type Detection

Built-in support for common file types:

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
| .jpg, .jpeg | image/jpeg |
| .png | image/png |
| .gif | image/gif |
| .webp | image/webp |

Unknown extensions default to `application/octet-stream`.

### Architecture

```
User Input (filepath)
       ↓
coordinator.prepareMessages()
       ↓
processDocumentContent()
  - Load file
  - Detect MIME
  - Encode base64
       ↓
Provider Compat Module
  - Transform to provider format
       ↓
LLM API
```

**Key Files**:
- `core/types.ts` - DocumentContent type definitions
- `utils/documents/document-loader.ts` - File loading and preprocessing
- `utils/documents/mime-types.ts` - MIME type detection
- `coordinator/coordinator.ts` - Message preprocessing integration
- `plugins/compat/*.ts` - Provider-specific transformations
- `vector_store_coordinator.ts` - Vector Store CLI entry point
- `coordinator/vector-coordinator.ts` - VectorStoreCoordinator class
- `core/vector-spec-types.ts` - VectorCallSpec and related types
- `utils/vector/vector-chunker.ts` - Text chunking utility
- `utils/vector/vector-context-injector.ts` - RAG context injection

## Vector Stores & Embeddings

### Overview

The coordinator provides unified vector store and embedding support for RAG (Retrieval Augmented Generation) applications. Like LLM providers, vector stores and embedding providers use a plugin architecture with priority-based fallback.

**Key Principle**: Provider-specific code lives ONLY in `plugins/`. Main codebase stays agnostic.

### Two Ways to Use Vector Stores

1. **Vector Store CLI** (`vector_store_coordinator.ts`): Batch operations for managing vector data (embed, upsert, query, delete, collections)
2. **VectorContextConfig** in `LLMCallSpec`: RAG context injection during LLM calls (auto-inject, tool mode, or both)

### Architecture

```
User Query → EmbeddingManager (agnostic) → embedding-compat (provider-specific) → OpenRouter/OpenAI
                    ↓
              Vector (numbers)
                    ↓
         VectorStoreManager (agnostic) → vector-compat (provider-specific) → Qdrant/Memory
```

### Embedding Providers

#### Configuration

Create JSON configs in `plugins/embeddings/`:

```json
// plugins/embeddings/openrouter.json
{
  "id": "openrouter-embeddings",
  "kind": "openrouter",
  "endpoint": {
    "urlTemplate": "https://openrouter.ai/api/v1/embeddings",
    "headers": {
      "Authorization": "Bearer ${OPENROUTER_API_KEY}",
      "Content-Type": "application/json"
    }
  },
  "model": "openai/text-embedding-3-small",
  "dimensions": 1536
}
```

#### Usage

```typescript
import { EmbeddingManager } from './managers/embedding-manager';
import { Registry } from './core/registry';

const registry = new Registry();
const embeddingManager = new EmbeddingManager(registry);

// Embed text with priority fallback
const result = await embeddingManager.embed('Hello world', [
  { provider: 'openrouter-embeddings' },
  { provider: 'backup-embeddings' }  // Falls back if first fails
]);

console.log(result.vectors);    // [[0.1, 0.2, ...]]
console.log(result.dimensions); // 1536
console.log(result.model);      // 'openai/text-embedding-3-small'

// Get dimensions for a provider
const dims = await embeddingManager.getDimensions('openrouter-embeddings');

// Create embedder function for VectorStoreManager
const embedFn = embeddingManager.createEmbedderFn([
  { provider: 'openrouter-embeddings' }
]);
```

### Vector Stores

#### Supported Providers

- **Qdrant**: Production-ready vector database
- **Memory**: In-memory store for testing

#### Configuration

Create JSON configs in `plugins/vector/`:

```json
// plugins/vector/qdrant-local.json
{
  "id": "qdrant-local",
  "kind": "qdrant",
  "connection": {
    "host": "localhost",
    "port": 6333
  },
  "defaultCollection": "documents"
}

// plugins/vector/qdrant-cloud.json
{
  "id": "qdrant-cloud",
  "kind": "qdrant",
  "connection": {
    "url": "https://your-cluster.qdrant.io",
    "apiKey": "${QDRANT_API_KEY}"
  },
  "defaultCollection": "documents"
}
```

#### Usage

```typescript
import { VectorStoreManager } from './managers/vector-store-manager';
import { EmbeddingManager } from './managers/embedding-manager';
import { Registry } from './core/registry';

const registry = new Registry();
const embeddingManager = new EmbeddingManager(registry);
const vectorStore = new VectorStoreManager(
  new Map(),  // configs
  new Map(),  // adapters
  embeddingManager.createEmbedderFn([{ provider: 'openrouter-embeddings' }]),
  registry
);

// Query with priority fallback
const { store, results } = await vectorStore.queryWithPriority(
  ['qdrant-local', 'qdrant-cloud'],  // Priority list
  'What is machine learning?',        // Query text (auto-embedded)
  5,                                   // Top K
  { category: 'tech' }                 // Optional filter
);

// Upsert points
await vectorStore.upsert('qdrant-local', [
  { id: 'doc1', vector: [0.1, 0.2, ...], payload: { text: 'Hello' } },
  { id: 'doc2', vector: [0.3, 0.4, ...], payload: { text: 'World' } }
]);

// Delete points
await vectorStore.deleteByIds('qdrant-local', ['doc1', 'doc2']);

// Access underlying compat for advanced operations
const compat = await vectorStore.getCompat('qdrant-local');
if (compat) {
  const exists = await compat.collectionExists('documents');
  if (!exists) {
    await compat.createCollection('documents', 1536, { distance: 'Cosine' });
  }
}

// Close all connections
await vectorStore.closeAll();
```

### Vector Store CLI

The Vector Store CLI (`vector_store_coordinator.ts`) provides batch operations for managing vector data outside of LLM calls.

#### Commands

| Command | Description |
|---------|-------------|
| `embed` | Embed texts and optionally upsert to a vector store |
| `upsert` | Upsert pre-computed vectors to a store |
| `query` | Query a vector store |
| `delete` | Delete vectors by ID |
| `collections` | Manage collections (list, create, delete, exists) |

#### Usage

```bash
# Embed texts and upsert
npx ts-node vector_store_coordinator.ts embed --spec '{
  "operation": "embed",
  "store": "qdrant-local",
  "embeddingPriority": [{ "provider": "openrouter-embeddings" }],
  "input": { "texts": ["Hello world", "Machine learning is..."] }
}'

# Embed with custom batch size (default: 10)
# The batchSize setting controls how many texts are embedded per API call.
# This applies to both streaming and non-streaming embed operations.
npx ts-node vector_store_coordinator.ts embed --spec '{
  "operation": "embed",
  "store": "qdrant-local",
  "embeddingPriority": [{ "provider": "openrouter-embeddings" }],
  "input": { "texts": ["Text 1", "Text 2", "Text 3", "Text 4", "Text 5"] },
  "settings": { "batchSize": 2 }
}'

# Query with a text query (auto-embedded)
npx ts-node vector_store_coordinator.ts query --spec '{
  "operation": "query",
  "store": "qdrant-local",
  "embeddingPriority": [{ "provider": "openrouter-embeddings" }],
  "input": { "query": "What is ML?", "topK": 5 }
}'

# Query with pre-computed vector
npx ts-node vector_store_coordinator.ts query --spec '{
  "operation": "query",
  "store": "qdrant-local",
  "input": { "vector": [0.1, 0.2, ...], "topK": 5 }
}'

# Delete vectors
npx ts-node vector_store_coordinator.ts delete --spec '{
  "operation": "delete",
  "store": "qdrant-local",
  "input": { "ids": ["doc1", "doc2"] }
}'

# List collections
npx ts-node vector_store_coordinator.ts collections --spec '{
  "operation": "collections",
  "store": "qdrant-local",
  "input": { "collectionOp": "list" }
}'

# Stream progress for batch operations
npx ts-node vector_store_coordinator.ts embed --stream --spec '{...}'
```

#### CLI Options

- `--spec <json>`: Spec as JSON string
- `--file <path>`: Path to spec JSON file
- `--plugins <path>`: Path to plugins directory (default: `./plugins`)
- `--pretty`: Pretty print output
- `--stream`: Stream progress events (for `embed` command)
- `--batch-id <id>`: Optional batch identifier for grouped logging

### VectorContextConfig (RAG Integration)

The `VectorContextConfig` field in `LLMCallSpec` enables automatic RAG (Retrieval Augmented Generation) during LLM calls.

#### Modes

| Mode | Behavior |
|------|----------|
| `auto` | Query vectors with user message, inject results before LLM call |
| `tool` | Create a `vector_search` tool the LLM can call on-demand |
| `both` | Auto-inject initial context + provide tool for follow-up queries |

#### Auto-Inject Mode

Context is automatically retrieved and injected into messages before the LLM call:

```typescript
const response = await coordinator.run({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is machine learning?' }] }
  ],
  llmPriority: [{ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }],
  vectorContext: {
    stores: ['qdrant-local'],
    mode: 'auto',
    topK: 5,
    scoreThreshold: 0.7,
    embeddingPriority: [{ provider: 'openrouter-embeddings' }],
    injectAs: 'system',  // or 'user_context'
    injectTemplate: 'Relevant context:\n\n{{results}}'
  }
});
```

#### Tool Mode

Creates a tool the LLM can call to search when needed:

```typescript
const response = await coordinator.run({
  messages: [...],
  llmPriority: [...],
  vectorContext: {
    stores: ['qdrant-local'],
    mode: 'tool',
    toolName: 'search_knowledge_base',  // default: 'vector_search'
    toolDescription: 'Search the knowledge base for relevant information',
    embeddingPriority: [{ provider: 'openrouter-embeddings' }],
    // Optional: allow the LLM to pass a metadata filter when not locked
    // The tool schema will include `filter` when `locks.filter` is not set
    locks: {
      // filter: { doc_type: 'faq' } // uncomment to lock a filter
    }
  }
});
```

When `locks.filter` is **not** set, the generated tool schema includes an optional `filter` (JSON object) so the LLM can constrain results (e.g., `{ "category": "tech", "year": 2024 }`). Filter precedence is:

1. `locks.filter` (highest, always enforced)
2. LLM-provided `filter` argument
3. `vectorContext.filter` fallback

Only `query` is required; `topK`, `store`, and `filter` are exposed only when their respective locks are unset.

#### Both Mode (Hybrid)

Auto-injects initial context AND provides a tool for follow-up queries:

```typescript
const response = await coordinator.run({
  messages: [...],
  llmPriority: [...],
  vectorContext: {
    stores: ['qdrant-local'],
    mode: 'both',
    topK: 3,
    injectAs: 'system',
    injectTemplate: 'Initial context:\n{{results}}\n\nYou can search for more using the search tool.',
    toolName: 'search_more',
    toolDescription: 'Search for additional information'
  }
});
```

#### VectorContextConfig Options

```typescript
interface VectorContextConfig {
  stores: string[];                       // Which stores to query
  mode: 'tool' | 'auto' | 'both';         // How to use results

  // Query config
  topK?: number;                          // Default: 5
  scoreThreshold?: number;                // Minimum score (0-1)
  filter?: JsonObject;                    // Metadata filter
  collection?: string;                    // Collection to query
  embeddingPriority?: EmbeddingPriorityItem[];

  // Query construction (auto/both modes)
  overrideEmbeddingQuery?: string;        // Use this exact query instead of extracting from messages
  queryConstruction?: QueryConstructionSettings;  // Control how query is built from messages

  // Auto-inject config
  injectAs?: 'system' | 'user_context';   // Default: 'system'
  injectTemplate?: string;                // Default: "Relevant context:\n{{results}}"
  resultFormat?: string;                  // Default: "- {{payload.text}} (score: {{score}})"

  // Tool mode config
  toolName?: string;                      // Default: 'vector_search'
  toolDescription?: string;

  // Parameter locking (tool mode only)
  locks?: VectorSearchLocks;              // Lock parameters from LLM override
}

interface QueryConstructionSettings {
  includeSystemPrompt?: 'always' | 'never' | 'if-in-range';  // Default: 'if-in-range'
  includeAssistantMessages?: boolean;     // Default: true
  messagesToInclude?: number;             // Default: 1 (0 = all messages)
}

interface VectorSearchLocks {
  store?: string;                         // Lock which store to use
  topK?: number;                          // Lock result count
  filter?: JsonObject;                    // Lock metadata filter
  scoreThreshold?: number;                // Lock minimum score
  collection?: string;                    // Lock collection name
}
```

#### Query Construction (Auto/Both Modes)

In `auto` and `both` modes, the adapter extracts a query from the conversation to embed and search the vector store. By default, it uses only the most recent user message. The `queryConstruction` settings give you control over this behavior.

**Query Construction Settings**

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `messagesToInclude` | number | `1` | How many recent messages to include. `0` = all messages |
| `includeAssistantMessages` | boolean | `true` | Whether assistant responses are included in query extraction |
| `includeSystemPrompt` | `'always'` \| `'never'` \| `'if-in-range'` | `'if-in-range'` | When to include system prompt in query |

**System Prompt Inclusion Logic**

- `'never'`: System prompt is never included in the query
- `'always'`: System prompt is always included
- `'if-in-range'`: Include if total messages (including system) ≤ `messagesToInclude`, or if `messagesToInclude` is 0 (all)

**Examples**

```typescript
// Default behavior: Last user message only
const response = await coordinator.run({
  systemPrompt: 'You are a coding assistant.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'How do promises work?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Promises are...' }] },
    { role: 'user', content: [{ type: 'text', text: 'Can you show an example?' }] }
  ],
  vectorContext: {
    stores: ['docs'],
    mode: 'auto'
    // Query will be: "Can you show an example?"
  }
});

// Include conversation context
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['docs'],
    mode: 'auto',
    queryConstruction: {
      messagesToInclude: 3,              // Last 3 messages
      includeAssistantMessages: true,    // Include assistant responses
      includeSystemPrompt: 'never'       // Don't include system prompt
    }
    // Query will combine last 3 messages for richer context
  }
});

// Override query extraction entirely
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['docs'],
    mode: 'auto',
    overrideEmbeddingQuery: 'JavaScript async/await patterns'
    // Ignores all messages, uses this exact query
  }
});
```

#### Parameter Locking (Tool Mode)

When using `tool` or `both` mode, the LLM can typically control parameters like `topK` and `store` through the tool schema. The `locks` feature allows you to enforce server-side parameter values that the LLM cannot override.

**Why Lock Parameters?**

- **Security**: Prevent LLM from accessing unauthorized stores or collections
- **Cost Control**: Limit result count to avoid excessive token usage
- **Quality**: Enforce minimum score thresholds for relevant results
- **Data Isolation**: Lock to specific collections per user/tenant

**How Locking Works**

1. Locked parameters are **hidden from the tool schema** - the LLM doesn't know they exist
2. Values are **enforced server-side** regardless of what the LLM attempts to pass
3. Non-locked parameters remain available for LLM control

```typescript
// Without locks - LLM can set all parameters
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['docs', 'faq', 'internal'],
    mode: 'tool',
    topK: 10
  }
});
// Tool schema exposes: query, topK, store
// LLM could request topK: 100, store: 'internal'

// With locks - enforce restrictions
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['docs', 'faq', 'internal'],
    mode: 'tool',
    topK: 10,
    locks: {
      store: 'docs',        // Only 'docs' store, hidden from LLM
      topK: 5,              // Max 5 results, hidden from LLM
      scoreThreshold: 0.7   // Minimum relevance, enforced server-side
    }
  }
});
// Tool schema exposes: query (only)
// LLM can only provide the search query
// store='docs', topK=5, scoreThreshold=0.7 are enforced
```

**Example: Multi-Tenant Data Isolation**

```typescript
// Lock collection per tenant to prevent cross-tenant access
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['qdrant-cloud'],
    mode: 'tool',
    locks: {
      collection: `tenant-${tenantId}`,  // Tenant-specific collection
      filter: { tenantId: tenantId }     // Additional filter as backup
    }
  }
});
```

**Example: Cost Control**

```typescript
// Limit results to control token usage
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['knowledge-base'],
    mode: 'tool',
    topK: 20,           // Default for non-locked use
    locks: {
      topK: 3,          // But lock to max 3 for this call
      scoreThreshold: 0.8  // Only highly relevant results
    }
  }
});
```

#### Tool Schema Overrides (Tool Mode)

When using `tool` or `both` mode, you can customize how parameters are exposed to the LLM using `toolSchemaOverrides`. This allows you to:

- **Rename parameters** for domain-specific or user-friendly labels
- **Override descriptions** to provide clearer guidance
- **Expose normally-hidden parameters** like `collection` and `scoreThreshold`
- **Hide normally-exposed parameters** without locking them

```typescript
interface ToolSchemaParamOverride {
  name?: string;        // Exposed name (LLM sees this)
  description?: string; // Custom description
  expose?: boolean;     // Whether to show in schema
}

interface ToolSchemaOverrides {
  toolDescription?: string;  // Override tool description
  params?: {
    query?: ToolSchemaParamOverride;
    topK?: ToolSchemaParamOverride;
    store?: ToolSchemaParamOverride;
    filter?: ToolSchemaParamOverride;
    collection?: ToolSchemaParamOverride;     // Hidden by default
    scoreThreshold?: ToolSchemaParamOverride; // Hidden by default
  };
}
```

**Example: Domain-Specific Parameter Names**

```typescript
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['product-docs'],
    mode: 'tool',
    toolSchemaOverrides: {
      toolDescription: 'Search our product documentation',
      params: {
        query: {
          name: 'search_query',
          description: 'Your search terms'
        },
        topK: {
          name: 'max_results',
          description: 'Maximum number of results (1-20)'
        },
        store: { expose: false },  // Hide store selection
        collection: {
          expose: true,
          name: 'category',
          description: 'Product category to search'
        }
      }
    }
  }
});
// Tool schema shows: search_query (required), max_results, category
// LLM calls with: { search_query: "...", max_results: 5, category: "widgets" }
// Adapter translates to: { query: "...", topK: 5, collection: "widgets" }
```

**Key Behaviors:**

1. **Alias Translation**: The adapter automatically translates aliased parameter names back to canonical names when invoking the tool
2. **Lock Precedence**: Locked parameters remain hidden even if `expose: true` is set in overrides
3. **Required Fields**: The `query` parameter (or its alias) is always required
4. **Default Exposure**: `query`, `topK`, `store`, `filter` are exposed by default; `collection` and `scoreThreshold` are hidden
5. **Duplicate Detection**: Throws an error if two parameters would have the same exposed name

**Combining with Locks:**

You can use both locks and schema overrides together. Locks take precedence for visibility:

```typescript
const response = await coordinator.run({
  messages: [...],
  vectorContext: {
    stores: ['docs'],
    mode: 'tool',
    locks: {
      store: 'docs'  // Hidden from schema and enforced
    },
    toolSchemaOverrides: {
      params: {
        topK: { name: 'limit' },      // Renamed but not locked
        store: { expose: true }        // Ignored - lock takes precedence
      }
    }
  }
});
// Tool schema shows: query (required), limit
// store is hidden because it's locked, not because of expose setting
```

#### VectorContext vs VectorPriority

These serve different purposes and can coexist:

- **`vectorPriority`**: Semantic tool selection - retrieves *tools* from vector stores based on relevance
- **`vectorContext`**: RAG context injection - retrieves *context* for the LLM to use

```typescript
{
  // vectorPriority for tool selection
  vectorPriority: ['tool-store'],

  // vectorContext for RAG
  vectorContext: {
    stores: ['doc-store'],
    mode: 'auto',
    topK: 5
  }
}
```

### Adding New Providers

#### Embedding Compat

Create `plugins/embedding-compat/your-provider.ts`:

```typescript
import { IEmbeddingCompat, EmbeddingProviderConfig, EmbeddingResult } from '../../core/types';

export default class YourProviderEmbeddingCompat implements IEmbeddingCompat {
  async embed(
    input: string | string[],
    config: EmbeddingProviderConfig,
    modelOverride?: string
  ): Promise<EmbeddingResult> {
    // Provider-specific API call
    return { vectors: [...], model: '...', dimensions: ... };
  }

  getDimensions(config: EmbeddingProviderConfig, model?: string): number {
    return config.dimensions || 0;
  }

  async validate(config: EmbeddingProviderConfig): Promise<boolean> {
    // Test API connectivity
  }
}
```

#### Vector Store Compat

Create `plugins/vector-compat/your-provider.ts`:

```typescript
import { IVectorStoreCompat, VectorStoreConfig, VectorPoint, VectorQueryResult } from '../../core/types';

export default class YourProviderCompat implements IVectorStoreCompat {
  async connect(config: VectorStoreConfig): Promise<void> { /* ... */ }
  async close(): Promise<void> { /* ... */ }
  async query(collection: string, vector: number[], topK: number, options?: VectorQueryOptions): Promise<VectorQueryResult[]> { /* ... */ }
  async upsert(collection: string, points: VectorPoint[]): Promise<void> { /* ... */ }
  async deleteByIds(collection: string, ids: string[]): Promise<void> { /* ... */ }
  async collectionExists(collection: string): Promise<boolean> { /* ... */ }
  async createCollection(collection: string, dimensions: number, options?: JsonObject): Promise<void> { /* ... */ }
}
```

### Types

```typescript
interface EmbeddingProviderConfig {
  id: string;
  kind: string;  // 'openrouter' | 'openai' | etc
  endpoint: { urlTemplate: string; headers: Record<string, string> };
  model: string;
  dimensions?: number;
}

interface VectorStoreConfig {
  id: string;
  kind: string;  // 'qdrant' | 'memory' | etc
  connection: JsonObject;
  defaultCollection?: string;
}

interface VectorPoint {
  id: string;
  vector: number[];
  payload?: JsonObject;
}

interface VectorQueryResult {
  id: string;
  score: number;
  payload?: JsonObject;
  vector?: number[];
}

interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  tokenCount?: number;
}
```

## OpenRouter Usage Accounting

OpenRouter provides detailed usage accounting including token counts, costs, and cache statistics. This is enabled by default for all OpenRouter requests.

### Automatic Usage Tracking

When using OpenRouter, the adapter automatically includes `usage: { include: true }` in all requests. This returns extended usage information in responses:

```typescript
const response = await coordinator.run({
  messages: [...],
  llmPriority: [
    { provider: 'openrouter', model: 'openai/gpt-4o' }
  ]
});

// response.usage contains extended fields:
console.log(response.usage);
// {
//   promptTokens: 100,
//   completionTokens: 50,
//   totalTokens: 150,
//   reasoningTokens: 25,        // If using reasoning models
//   cost: 0.00125,              // Cost in credits
//   cachedTokens: 75,           // Tokens read from cache
//   audioTokens: 10             // Audio tokens (if applicable)
// }
```

### Extended Usage Fields

| Field | Type | Description |
|-------|------|-------------|
| `promptTokens` | number | Tokens in the input/prompt |
| `completionTokens` | number | Tokens in the response |
| `totalTokens` | number | Combined token count |
| `reasoningTokens` | number | Tokens used for reasoning (supported models) |
| `cost` | number | Total cost in credits |
| `cachedTokens` | number | Tokens read from prompt cache |
| `audioTokens` | number | Audio tokens (if using audio features) |

### Disabling Usage Accounting

If you need to disable usage accounting (e.g., to reduce latency), you can override the default:

```typescript
const response = await coordinator.run({
  messages: [...],
  llmPriority: [
    { provider: 'openrouter', model: 'openai/gpt-4o' }
  ],
  extra: {
    usage: { include: false }
  }
});
```

### Logging

Extended usage stats are included in both console and file logs:

```json
{
  "type": "log",
  "level": "info",
  "message": "Provider response processed",
  "data": {
    "provider": "openrouter",
    "model": "openai/gpt-4o",
    "usage": {
      "promptTokens": 100,
      "completionTokens": 50,
      "reasoningTokens": null,
      "cost": 0.00125,
      "cachedTokens": 75,
      "audioTokens": null
    }
  }
}
```

## Configuration

### Centralized Defaults

All non-provider-specific defaults are centralized in `/plugins/configs/defaults.json`. This provides a single source of truth for configuration values and makes the codebase easier to maintain.

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
    "injectTemplate": "Relevant context:\n{{results}}",
    "resultFormat": "- {{payload.text}} (score: {{score}})",
    "batchSize": 10,
    "includePayload": true,
    "includeVector": false,
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
  "paths": {
    "plugins": "./plugins"
  }
}
```

#### Accessing Defaults in Code

```typescript
import { getDefaults } from './core/defaults';

const defaults = getDefaults();
console.log(defaults.retry.maxAttempts);  // 3
console.log(defaults.tools.maxIterations); // 10
```

#### Provider-Specific Defaults

Provider-specific defaults live in their respective JSON manifests under the `defaults` field:

```json
// plugins/providers/anthropic.json
{
  "id": "anthropic",
  "defaults": {
    "maxTokens": 8192,
    "reasoningBudget": 51200
  }
}
```

#### Runtime Overrides

All defaults can be overridden at runtime via the call spec:

```typescript
await coordinator.run({
  messages: [...],
  settings: {
    maxTokens: 4096  // Overrides provider default
  },
  maxToolIterations: 5  // Overrides tools.maxIterations
});
```

## Testing

The library maintains 100% test coverage. Run tests with:

```bash
npm test
```

Document-specific tests:
```bash
npm test -- --testPathPattern="document"
```

Coverage report:
```bash
npm test -- --coverage
```

### Sandbox scenarios (manual)

Ad-hoc CLI runner for scripted or interactive conversations that write transcripts + copied logs under `tests/sandbox/logs/`.

- Scripted scenario: `npm run sandbox:cli -- --scenario tests/sandbox/scenarios/example.yml`
- Interactive-only (no preset turns): `npm run sandbox:cli -- --scenario tests/sandbox/scenarios/interactive-empty.yml`

## Logging

- Use factory helpers from `core/logging.ts`:
  - `getLLMLogger()` (also available via `getLogger()`) for LLM HTTP + console logs
  - `getEmbeddingLogger()` for embedding requests/responses
  - `getVectorLogger()` for vector store operations
- Each logger lazily creates its own log directory (`logs/llm`, `logs/embedding`, `logs/vector`) the first time you write a log entry, reducing startup I/O for workers that only use one call type.
- `closeLogger()` now shuts down all logger singletons and waits up to 2s to flush transports; call this when switching batch IDs or shutting down long-running workers.
- Batch env vars (`LLM_ADAPTER_BATCH_ID`, `LLM_ADAPTER_BATCH_DIR`) continue to apply per logger and are enforced during the first write via retention policies.
- Retention runs safely even before the first log file is created, so batch pruning can be triggered up front without creating placeholder files.

### CorrelationId

The `correlationId` field allows you to tag log entries with one or more identifiers to track requests across your system. Unlike batch IDs which control log file naming, correlation IDs appear inside individual log entries.

#### Usage

Pass `correlationId` via the `metadata` field in your `LLMCallSpec`:

```typescript
// Single correlationId
const response = await coordinator.run({
  messages: [...],
  llmPriority: [...],
  metadata: {
    correlationId: 'request-123'
  }
});

// Multiple correlationIds (e.g., request + user + session)
const response = await coordinator.run({
  messages: [...],
  llmPriority: [...],
  metadata: {
    correlationId: ['req-123', 'user-456', 'session-789']
  }
});
```

#### Where CorrelationId Appears

1. **Console/File Logs**: JSON output includes `correlationId` field
   ```json
   {"type":"log","timestamp":"...","level":"info","message":"Calling provider","correlationId":["req-123","user-456"]}
   ```

2. **Detail Logs**: LLM, Embedding, and Vector detail logs include `CorrelationId:` line
   ```
   >>> OUTGOING REQUEST >>>
   Timestamp: 2025-12-06T07:30:00.000Z
   CorrelationId: req-123, user-456
   Provider: anthropic
   ...
   ```

#### Direct Logger Usage

You can also use correlationId directly with loggers:

```typescript
import { getLLMLogger } from './core/logging';

// Create logger with correlationId
const logger = getLLMLogger().withCorrelation('request-123');

// Or with multiple IDs
const logger = getLLMLogger().withCorrelation(['req-123', 'user-456']);

logger.info('Processing request');
```

### Live Tests

Live tests make real API calls to test actual integrations. They require API keys and external services.

#### Prerequisites

Set required environment variables:
```bash
# For LLM providers
export ANTHROPIC_API_KEY=your-key
export OPENAI_API_KEY=your-key
export OPENROUTER_API_KEY=your-key
export GOOGLE_API_KEY=your-key

# For Qdrant Cloud (optional)
export QDRANT_CLOUD_URL=https://your-cluster.qdrant.io
export QDRANT_API_KEY=your-key
```

Qdrant notes:
- Point IDs must be UUIDs or integers (e.g., `11111111-1111-1111-1111-111111111111`). Non-UUID strings will be rejected by the API.
- Filtering by payload fields on Qdrant Cloud requires creating a payload index first (e.g., add `payloadIndexes: [{ field: 'category', type: 'keyword' }]` when creating the collection).

For local Qdrant, start the server:
```bash
docker run -p 6333:6333 qdrant/qdrant
```

#### Running Live Tests

```bash
# Run ALL tests (unit + integration + live) - for CI
npm run test:all

# Run only live tests (all providers)
npm run test:live

# Run live tests for a specific LLM provider
npm run test:live:anthropic    # Anthropic only
npm run test:live:openai       # OpenAI only
npm run test:live:openrouter   # OpenRouter only
npm run test:live:google       # Google only

# Run embedding live tests only
npm run test:live:embeddings

# Run vector store live tests (Qdrant Cloud)
npm run test:live:vector
```

#### Provider Filtering

You can run live tests for specific providers using the `LLM_TEST_PROVIDERS` environment variable:

```bash
# Single provider
LLM_TEST_PROVIDERS=anthropic npm run test:live

# Multiple providers (comma-separated)
LLM_TEST_PROVIDERS=anthropic,google npm run test:live

# Case-insensitive
LLM_TEST_PROVIDERS=ANTHROPIC npm run test:live
```

Available provider names: `anthropic`, `openai-responses`, `openrouter`, `google`

This is useful for:
- Faster iteration when debugging a specific provider
- Running tests when you only have API keys for certain providers
- Reducing API costs during development

#### Available Live Test Suites

| Test File | Description |
|-----------|-------------|
| `15-embeddings.live.test.ts` | OpenRouter embeddings API |
| `16-vector-store.live.test.ts` | Qdrant vector store operations |
| `17-vector-cli.live.test.ts` | Vector Store CLI operations |
| `18-vector-auto-inject.live.test.ts` | VectorContext RAG integration |
| `19-vector-search-locks.live.test.ts` | Vector search parameter locking |
| `00-14-*.live.test.ts` | LLM provider tests |
