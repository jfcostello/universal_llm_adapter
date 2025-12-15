# `plugins/vector-compat/qdrant`

Vector store compat implementation.

## Public API
- Default export from `index.ts`

## Internal layout (B)
- `internal/qdrant.ts` – compat orchestration
- `internal/client/create-client.ts` – client construction helpers
- `internal/ids/normalize-point-id.ts` – id normalization + deterministic UUID mapping
- `internal/filters/convert-filter.ts` – filter conversion
- `internal/operations/*` – connect/query/upsert/delete/collections operations

## Notes
- Loaded by the plugin registry via the vector store's `kind`.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
