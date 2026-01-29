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

Routing happens in two steps:
1) Resolve routing hints (`toolId`, `processRouteId`) from tool definitions + runtime overrides.
2) Select the process route (and then fall back to matchers).

### Resolve routing hints

`processRouteId` precedence (highest → lowest):
1. Runtime override by name: `spec.toolRouting.routesByName[toolName]`
2. Runtime override by id: `spec.toolRouting.routesById[toolId]`
3. Tool definition: `UnifiedTool.processRouteId`

All values are trimmed; blank strings are treated as unset.

If an explicit route id is specified (steps 1–3) and it does not exist in `plugins/processes/*.json`, routing fails fast with a clear error.

### Select route

Route selection precedence (highest → lowest):
1. Explicit `processRouteId`
2. Exact id shortcut: `route.id === toolId`
3. `ProcessRouteManifest.matchToolId` (matches `toolId`)
4. `ProcessRouteManifest.match` (matches tool name)
5. MCP prefix fallback: when MCP is configured, tool names starting with `${serverId}.` or `${serverId}_` are routed to a virtual `invoke.kind: "mcp"` route for that server.

Note: MCP fallback route ids (`mcp-${serverId}`) are internal and are not valid values for explicit `processRouteId`. Use name-prefix routing (or define an explicit process route with `invoke.kind: "mcp"` if you need a stable route id).
