# LLM Module

Owns LLM orchestration (non-streaming + streaming), including:
- `LLMCoordinator` (public facade)
- `LLMManager` (provider execution + streaming)
- `StreamCoordinator` (stream parsing + tool-loop coordination)

## Compatibility Fallbacks
- **Unsupported reasoning params:** if a provider returns an `unsupported_parameter` error for `reasoning`/`reasoning.*`, `LLMManager` retries once with reasoning stripped. For non-live runs, it caches the `(provider, model)` pair to avoid repeated failures.
- **Reasoning disable rejected:** if a provider rejects an explicit attempt to disable reasoning (e.g. "reasoning cannot be disabled"), `LLMManager` retries once with reasoning stripped so the call can proceed.
- **Rate limit detection:** treats HTTP `429` and `Retry-After` as rate limits, and scans response bodies for configured retry keywords.
- **Required tool-choice streaming guard:** when `toolChoice` requires an initial tool call, `StreamCoordinator` buffers pre-tool text until tool-call intent is confirmed. If no tool call is emitted, it retries with a strict reminder and suppresses leaked pre-tool text from failed attempts.
- **Text-like document inlining (guarded):** `LLMCoordinator` may inline base64 `document` parts with text-like MIME types (`text/*`, `application/json`, `application/xml`) into a plain `text` content part so text-only models can still answer doc-grounded questions.
  - Disable: `LLM_ADAPTER_DISABLE_TEXT_DOCUMENT_INLINING=1`
  - Size cap: `LLM_ADAPTER_TEXT_DOCUMENT_INLINE_MAX_BYTES=<bytes>` (default `262144`; set to `0` to disable)

## Performance

Performance knobs are opt-in; defaults preserve current behavior.

### Outbound HTTP Keep-Alive (LLM HTTP calls only)

- Defaults (from `plugins/configs/defaults.json`): `outboundHttp.keepAliveEnabled=false`, `outboundHttp.maxSockets=256`, `outboundHttp.maxFreeSockets=32`
- Env override: `LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED=1` (boolean-like; uses shared `normalizeFlag` semantics)

### Streaming Chunk Info Logs

By default, streaming logs include an `info` line per received chunk.

- Default: `logging.llmStream.chunkInfoLogsEnabled=true`
- Env override: `LLM_ADAPTER_LLM_STREAM_CHUNK_LOGS_ENABLED=0` to disable per-chunk `info` logs

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
