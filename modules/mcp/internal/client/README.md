# MCP Client (internal)

MCP client-side primitives for JSON-RPC sessions, transport connections, and connection pooling.

## Entry points
- `index.ts`: exports `JSONRPCSession`, `MCPConnection`, and `MCPClientPool`.
- `internal/*`: low-level implementations and helpers (including package metadata).

## Responsibilities
- Maintain a JSON-RPC session over an underlying transport.
- Manage connection lifecycle and reconnection behavior.
- Pool and reuse connections across MCP server invocations.

## Import rules
- Runtime code should import from `modules/mcp/index.ts`.
- Do not import from `modules/mcp/internal/client/internal/**` outside of `modules/mcp`.

