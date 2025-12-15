# `modules/logging`

Logging primitives and factories.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/logging/index.ts` (tests may import internals).
- Default behavior must remain unchanged unless explicitly requested.

## Exports
- `getLogger()`, `getLLMLogger()`, `getEmbeddingLogger()`, `getVectorLogger()`, `closeLogger()`
- Logger classes and shared types from the internal logger implementation
- Retention helpers used by loggers

