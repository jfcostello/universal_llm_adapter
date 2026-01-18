# Tool Coordinator (internal)

Routes and invokes tool calls using configured process routes, optional MCP servers, and built-in vector search integration.

## Entry points
- `index.ts`: exports `ToolCoordinator`.
- `internal/*`: invocation helpers (timeouts, spawn logic, module path resolution, types).

## Responsibilities
- Match tool names to a configured invocation route.
- Invoke tools via process execution or MCP, enforcing timeouts.
- Optionally dispatch built-in vector search when configured via vector context.

## Import rules
- Runtime code should import from `modules/tools/index.ts`.
- Do not import from `modules/tools/internal/tool-coordinator/internal/**` outside of `modules/tools`.

