# Vector Store Coordinator (internal)

Coordinates vector operations (embed/upsert/query/delete/collections) against configured vector store and embedding compat modules.

## Entry points
- `index.ts`: exports `VectorStoreCoordinator`.
- `internal/*`: operation executors, shared state management, and spec helpers.

## Responsibilities
- Execute vector operations using the correct compat implementations.
- Manage shared state (embedding/vector managers) and ensure they are closed cleanly.
- Provide streaming where supported and normalize operation results/errors.

## Import rules
- Runtime code should import from `modules/vector/index.ts`.
- Do not import from `modules/vector/internal/vector-store-coordinator/internal/**` outside of `modules/vector`.

