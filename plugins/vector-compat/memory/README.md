# `plugins/vector-compat/memory`

Vector store compat implementation.

## Public API
- Default export from `index.ts`

## Internal layout (A)
- `internal/memory.ts` – compat orchestration
- `internal/store.ts` – in-memory vector store
- `internal/query.ts` – query implementation

## Notes
- Loaded by the plugin registry via the vector store's `kind`.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
