# `plugins/compat/anthropic`

Provider compat implementation.

## Public API
- Default export from `index.ts`

## Notes on thinking + tools
- When tool choice forces tool use, the compat omits `thinking` to avoid provider-side validation errors.

## Notes
- Loaded by the plugin registry via the provider's `compat` setting.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
