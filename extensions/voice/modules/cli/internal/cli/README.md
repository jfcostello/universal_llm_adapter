# Voice CLI (internal)

Implements the `llm-adapter voice ...` command group for the voice extension.

## Entry point
- `index.ts`: `runVoiceCli()` builds the Commander program and registers all subcommands.

## Layout
- `internal/commands/*`: individual subcommands (`call`, `end`, `transfer`, `events`, `recording`).
- `internal/sse.ts`: streaming event consumption helpers.
- `internal/utils.ts`: structured error output helpers.
- `internal/types.ts`: shared command context + IO/deps interfaces.

## Import rules
- Runtime code must import only from `extensions/voice/modules/cli/index.ts`.
- Do not import from `extensions/voice/modules/cli/internal/**` outside of the voice CLI module.

