# Vector Module

Owns vector store orchestration, RAG context injection, and the built-in vector search tool execution.

## Import Rules
- Runtime code must import only from `modules/vector/index.ts`.
- Do not import from `modules/vector/internal/**` outside of this module.

## Lazy-loading Contract
- This module must not import embeddings code unless an operation actually requires embeddings.
- `executeVectorSearch()` and auto-inject flows resolve embedding priority from:
  1) `vectorContexts[].storePriority[<store>].attempts[].embeddingPriority`, else
  2) `VectorContextConfig.embeddingPriority`, else
  3) the vector store plugin manifest default, else
  4) an error that tells the user what to configure.

## Store Priority Fallback
- `vectorContexts[].storePriority` defines ordered fallback attempts per logical `stores[]` entry.
- Each attempt can override:
  - `store`
  - `collection`
  - `embeddingPriority`
- Default fallback behavior:
  - Continue only when the current attempt fails or returns an incomplete response.
  - Do not fallback on empty results unless `fallbackOnEmpty: true` is set for that store chain.

## Public API
- `VectorStoreManager` for vector store compat orchestration.
- `VectorStoreCoordinator` for CLI/server vector operations.
- `VectorContextInjector` for `vectorContexts[].mode: 'auto' | 'both'` injection.
- `executeVectorSearch` + `formatVectorSearchResults` for tool execution and formatting.
- `chunkText` / `chunkFile` for ingestion chunking helpers.
