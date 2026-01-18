# LLM Coordinator (internal)

`LLMCoordinator` is the orchestration layer for a single LLM call (non-streaming or streaming). It wires together optional subsystems based on the spec (tools, MCP, vector context, observability) while preserving strict lazy-loading.

## Entry points
- `index.ts`: `LLMCoordinator` (public facade for the module).
- `internal/*`: helpers for message preparation and the stream/non-stream runners.

## Responsibilities
- Prepare messages (including document handling) before execution.
- Collect tools and optional integrations (only when requested by the spec).
- Run the non-stream and stream flows.
- Manage lifecycle concerns (logging, optional observability, optional usage-cost attachment).

## Lazy-loading contract
For a baseline LLM run that does not request tools/MCP/vector/observability, this coordinator must not import/evaluate those modules.

## Import rules
- Runtime code must import from `modules/llm/index.ts`.
- Do not import from `modules/llm/internal/llm-coordinator/internal/**` outside of `modules/llm`.

