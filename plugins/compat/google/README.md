# `plugins/compat/google`

Provider compat implementation.

## Public API
- Default export from `index.ts`

## Internal layout (A)
- `internal/google.ts` – compat orchestration
- `internal/mappings.ts` – wire-format mapping spec
- `internal/messages.ts` – message serialization
- `internal/settings.ts` – settings serialization
- `internal/tools.ts` – tool + tool-choice serialization
- `internal/response.ts` – response parsing
- `internal/stream.ts` – streaming parsing/state

## Notes
- Loaded by the plugin registry via the provider's `compat` setting.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
