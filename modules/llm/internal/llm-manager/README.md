# LLM Manager (internal)

`LLMManager` executes provider requests (non-streaming and streaming) and normalizes the results into the adapter’s canonical response/event shapes.

Provider-specific mapping must remain in the plugin compat layer; `LLMManager` stays provider-agnostic and works through the registry + compat interfaces.

## Entry points
- `index.ts`: `LLMManager`.
- `internal/*`: HTTP/stream helpers and small focused utilities.

## Responsibilities
- Execute HTTP calls (via a shared Axios client) for non-stream and stream paths.
- Apply retry and compatibility fallbacks (rate limits, unsupported params, etc.).
- Normalize raw responses into `LLMResponse` / stream events.
- Emit observability hooks when enabled by the caller/context.

## Import rules
- Runtime code must import from `modules/llm/index.ts`.
- Do not import from `modules/llm/internal/llm-manager/internal/**` outside of `modules/llm`.

