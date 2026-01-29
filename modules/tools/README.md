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

## Terminal Tool Calls
`runToolLoop` supports **terminal** tool calls that stop the loop immediately after tool execution (no follow-up LLM call).

Terminal can be set via:
- Tool definition: `UnifiedTool.terminal: true`
- Tool result override: `tool_type_response_override_terminal: true|false` (strict boolean; top-level overrides nested)

When terminal, the response `finishReason` is set to `tool_stop`.

## Tool Routing

Tool routing is handled by `ToolCoordinator` via process routes (`plugins/processes/*.json`).

Routing precedence (highest → lowest):

1. Explicit `processRouteId` from runtime (`spec.toolRouting`) or tool definitions (`UnifiedTool.processRouteId`)
2. `ProcessRouteManifest.matchToolId` (matches `UnifiedTool.id`)
3. `ProcessRouteManifest.match` (matches tool name)
