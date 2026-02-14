# Vector Module

Owns vector store orchestration, RAG context injection, and the built-in vector search tool execution.

## Import Rules
- Runtime code must import only from `modules/vector/index.ts`.
- Do not import from `modules/vector/internal/**` outside of this module.

## Lazy-loading Contract
- This module must not import embeddings code unless an operation actually requires embeddings.
- `executeVectorSearch()` and auto-inject flows resolve embedding priority from:
  1) `VectorContextConfig.embeddingPriority`, else
  2) the vector store plugin manifest default, else
  3) an error that tells the user what to configure.

## Public API
- `VectorStoreManager` for vector store compat orchestration.
- `VectorStoreCoordinator` for CLI/server vector operations.
- `VectorContextInjector` for `vectorContexts[].mode: 'auto' | 'both'` injection.
- `executeVectorSearch` + `formatVectorSearchResults` for tool execution and formatting.
- `chunkText` / `chunkFile` for ingestion chunking helpers.

## Query Priority Candidates
- Shared runtime lives at `modules/vector/internal/query-priority/`.
- `vectorContexts[].queryPriority` executes candidates in order and falls back only on call failure:
  - embed call failure, or
  - no store query call completes for that candidate.
- Empty result sets are successful and stop fallback.
- Candidate precedence:
  - `stores`: `candidate.stores ?? context.stores`
  - `collection`: candidate required
  - `embeddingPriority`: candidate required
  - retrieval params: candidate -> context/defaults, then locks override.
- Validation rules:
  - each candidate must define `collection` and `embeddingPriority`.
  - `locks.collection` cannot be used with `queryPriority` (`config_error`, status `400`).
