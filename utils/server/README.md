# `utils/server` (legacy shim)

This directory is a legacy entrypoint maintained during the migration to the module layout.

- Public API lives in `modules/server`.
- `utils/server/index.ts` re-exports `modules/server/index.ts`.

Server endpoints (see `modules/server/README.md` for details):
- `GET /health`
- `GET /ready`
- `POST /run`
- `POST /stream`
- `POST /vector/run`
- `POST /vector/stream`
- `POST /vector/embeddings/run`
