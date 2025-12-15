# MCP Module

Owns MCP configuration parsing and the MCP client/manager implementation.

## Import Rules
- Runtime code must import only from `modules/mcp/index.ts`.
- Do not import from `modules/mcp/internal/**` outside of this module.

## Public API
- `parseMCPManifest(manifest, sourceName)` → `MCPServerConfig[]`
- `MCPConnection` / `MCPClientPool` for JSON-RPC tool calls
- `MCPManager` for orchestrating multiple MCP servers

