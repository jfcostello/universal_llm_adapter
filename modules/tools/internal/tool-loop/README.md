# Tool Loop (internal)

Executes the tool-calling loop for LLM runs (streaming and non-streaming), enforcing budgets and preserving tool results according to runtime settings.

## Entry points
- `index.ts`: exports `runToolLoop` (stream and non-stream overloads) and `__toolLoopTestUtils__`.
- `internal/*`: stream/non-stream implementations, execution helpers, runtime parsing, and shared utilities.

## Responsibilities
- Execute tool calls returned by the model and feed results back into follow-up model calls.
- Enforce iteration/call budgets and provide progress metadata.
- Handle streaming and non-streaming execution modes consistently.

## Import rules
- Runtime code should import from `modules/tools/index.ts`.
- Do not import from `modules/tools/internal/tool-loop/internal/**` outside of `modules/tools`.

