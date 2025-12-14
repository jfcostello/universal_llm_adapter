# Tools Module

Owns tool discovery, tool loop orchestration, and tool routing (process routes + optional sources).

## Import Rules
- Runtime code must import only from `modules/tools/index.ts`.
- Do not import from `modules/tools/internal/**` outside of this module.

## Lazy-loading Contract
- Importing and running a baseline LLM call without tools must not import/evaluate this module.
- This module must not statically import `modules/mcp` or `modules/vector`.
  - Vector search execution must be dynamically imported from `modules/vector/index.ts` only when the vector search tool is invoked.
## Public API
- `collectTools` (discovery + schema creation)
- `runToolLoop` (non-stream + stream tool loops)
- `ToolCoordinator` (process routing)
- `sanitizeToolName` / `sanitizeToolChoice` / `normalizeToolCalls`
