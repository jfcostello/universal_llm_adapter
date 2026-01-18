# Server Handler (internal)

HTTP/SSE request handler and routing layer for the adapter server.

## Entry points
- `index.ts`: exports `createServerHandler` (a Node `http.RequestListener`).
- `internal/*`: request context creation, routing, response helpers, and endpoint handlers.

## Responsibilities
- Normalize request context (plugins path, auth, timeouts, limits).
- Route requests to the correct handler (LLM, vector, embeddings, realtime, extensions).
- Handle SSE streaming responses and common HTTP response behavior.
- Apply request security helpers (headers, validation, CORS/security policies as configured).

## Import rules
- Runtime code should import from `modules/server/index.ts`.
- Do not import from `modules/server/internal/handler/internal/**` outside of `modules/server`.

