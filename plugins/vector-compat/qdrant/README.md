# `plugins/vector-compat/qdrant`

Vector store compat implementation.

## Public API
- Default export from `index.ts`

## Notes
- Loaded by the plugin registry via the vector store's `kind`.
- Implementation details live in `internal/` and must not be imported directly outside this directory.

