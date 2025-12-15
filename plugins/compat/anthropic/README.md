# `plugins/compat/anthropic`

Provider compat implementation.

## Public API
- Default export from `index.ts`

## Internal layout (A)
- `internal/anthropic.ts` – compat orchestration
- `internal/mappings.ts` – wire-format mapping spec
- `internal/messages.ts` – message serialization
- `internal/settings.ts` – settings serialization
- `internal/tools.ts` – tool + tool-choice serialization
- `internal/response.ts` – response parsing
- `internal/stream.ts` – streaming parsing/state

## Notes on thinking + tools
- When tool choice forces tool use, the compat omits `thinking` to avoid provider-side validation errors.

## Notes
- Loaded by the plugin registry via the provider's `compat` setting.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
