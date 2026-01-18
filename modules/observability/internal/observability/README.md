# Observability (internal)

Core observability plumbing: exporter wiring, runtime helpers, and dependency construction.

## Entry points
- `index.ts`: exports the `ObservabilityExporter` facade and `createObservabilityDeps` helper, plus re-exports of kernel types/deps utilities.
- `internal/*`: exporter implementation, config/types, runtime helpers, and size-limited sending utilities.

## Responsibilities
- Construct observability dependencies on-demand based on runtime configuration.
- Provide exporter implementations and helpers for encoding/sending events.
- Keep observability optional and lazy-loaded.

## Import rules
- Runtime code should import from `modules/observability/index.ts`.
- Do not import from `modules/observability/internal/observability/internal/**` outside of `modules/observability`.

