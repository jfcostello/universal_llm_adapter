# `plugins/compat/openai-responses`

Provider compat implementation.

## Public API
- Default export from `index.ts`

## Behavior
- Serializes messages to the OpenAI Responses API `input` format (string for a single text user message, otherwise an array of input items).
- Maps settings:
  - `maxTokens` → `max_output_tokens`
  - `temperature` → `temperature`
  - `topP` → `top_p`
  - `reasoning` → `reasoning.effort` (derived when `enabled/budget` is provided without an explicit effort)
- Serializes tools to Responses API `tools` (`type: "function"`) and maps tool choice to `tool_choice`.

## Internal layout (A)
- `internal/openai-responses.ts` – compat orchestration
- `internal/mappings.ts` – wire-format mapping spec
- `internal/messages.ts` – message serialization
- `internal/settings.ts` – settings serialization
- `internal/tools.ts` – tool + tool-choice serialization
- `internal/response.ts` – response parsing
- `internal/stream.ts` – streaming parsing/state

## Notes
- Loaded by the plugin registry via the provider's `compat` setting.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
