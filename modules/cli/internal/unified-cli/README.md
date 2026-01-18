# Unified CLI (internal)

Implements the unified `llm-adapter` Commander program used by `modules/cli`.

## Entry points
- `index.ts`: `createUnifiedProgram()` (builds a `Command`) and `runUnifiedCli()` (parses argv).

## Architecture
- Command registration is split by domain (`internal/register-*.ts`) to keep each file small and cohesive.
- Dependency injection is provided via `UnifiedCliDependencies` (`internal/deps.ts`) so tests can replace side effects.

## Lazy-loading contract
`createUnifiedProgram()` must remain cheap. Heavy modules are dynamically imported inside command handlers so `llm-adapter --help` stays fast.

## Layout
- `internal/deps.ts`: default deps (dynamic imports) + DI types.
- `internal/register-*.ts`: command registration and handler wiring.
- `internal/types.ts`: shared context types for command registration.

## Import rules
- Runtime code must import only from `modules/cli/index.ts`.
- Do not import from `modules/cli/internal/unified-cli/**` outside of the CLI module.

