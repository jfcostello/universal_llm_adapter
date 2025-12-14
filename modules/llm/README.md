# LLM Module

Owns LLM orchestration (non-streaming + streaming), including:
- `LLMCoordinator` (public facade)
- `LLMManager` (provider execution + streaming)
- `StreamCoordinator` (stream parsing + tool-loop coordination)

## Import Rules
- Runtime code must import only from `modules/llm/index.ts`.
- Do not import from `modules/llm/internal/**` outside of this module.

## Lazy-loading Contract
- A baseline LLM run (no tools/MCP/vector) must not import/evaluate:
  - `modules/tools`
  - `modules/mcp`
  - `modules/vector` (and embeddings)
- Optional feature wiring is loaded only when requested by the spec:
  - tools → `modules/tools`
  - MCP → `modules/mcp`
  - vector context injection → `modules/vector` (+ `modules/embeddings`)

## Public API
- `LLMCoordinator`
- `LLMManager`
- `StreamCoordinator` (primarily for tests)

