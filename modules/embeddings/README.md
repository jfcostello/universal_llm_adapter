# Embeddings Module

Owns embedding orchestration and the embedding coordinator.

## Import Rules
- Runtime code must import only from `modules/embeddings/index.ts`.
- Do not import from `modules/embeddings/internal/**` outside of this module.

## Public API
- `EmbeddingManager` for embedding orchestration with priority fallback.
- `EmbeddingCoordinator` for running embedding specs (CLI/server lifecycle).

## Behavior notes
- `EmbeddingManager` uses shared retry policy semantics per provider attempt.
- Provider order is preserved: retry attempts occur inside a provider before fallback.
- Abort signals short-circuit retries and prevent fallback continuation.
