# `plugins/embedding-compat/openrouter`

Embedding compat implementation.

## Public API
- Default export from `index.ts`

## Internal layout (A)
- `internal/openrouter.ts` – compat orchestration
- `internal/http.ts` – HTTP request builder
- `internal/response.ts` – response parsing + error classification
- `internal/mappings.ts` – wire-format mapping spec

## Notes
- Loaded by the plugin registry via the embedding provider's `kind`.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
- `internal/response.ts` classifies transient embedding failures for OpenRouter-specific behavior, including:
  - HTTP `429`
  - HTTP `5xx` (including `529`)
  - upstream message pattern `No successful provider responses`
