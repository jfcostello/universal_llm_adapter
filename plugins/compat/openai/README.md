# `plugins/compat/openai`

Provider compat implementation.

## Public API
- Default export from `index.ts`

## Internal layout (A)
- `internal/openai.ts` – compat orchestration
- `internal/mappings.ts` – wire-format mapping spec
- `internal/messages.ts` – message serialization
- `internal/settings.ts` – settings serialization
- `internal/tools.ts` – tool + tool-choice serialization
- `internal/response.ts` – response parsing
- `internal/stream.ts` – streaming parsing/state
- `internal/extensions.ts` – optional provider payload extensions (when configured)

## Notes
- Loaded by the plugin registry via the provider's `compat` setting.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
