# CLI Module

Canonical home for CLI helpers and program factories.

## Import Rules
- Runtime code must import only from `modules/cli/index.ts`.
- Do not import from `modules/cli/internal/**` outside of this module.

## Public API

### Spec + output helpers
- `loadSpec<T>(options, stdin?)`
- `writeJsonToStdout(value, options?)`

### Program factories
- `createLlmCoordinatorProgram(partialDeps?)`
- `runLlmCoordinatorCli(argv?)`
- `createVectorStoreCoordinatorProgram(partialDeps?)`
- `runVectorStoreCoordinatorCli(argv?)`

Both programs support dependency injection for tests and alternative transports.
