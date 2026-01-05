# `modules/logging`

Logging primitives and factories.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/logging/index.ts` (tests may import internals).
- Default behavior must remain unchanged unless explicitly requested.

## Exports
- `getLogger()`, `getLLMLogger()`, `getEmbeddingLogger()`, `getVectorLogger()`, `closeLogger()`
- `getVoiceLogger()`, `getRealtimeLogger()`
- Logger classes and shared types from the internal logger implementation
- Retention helpers used by loggers

## File Logs

When file logging is enabled (default), loggers write under `./logs/`:
- `logs/llm/` (LLM request/response logs)
- `logs/embedding/` (embedding request/response logs)
- `logs/vector/` (vector store operation logs)
- `logs/voice/` (voice/telephony lifecycle logs; JSONL)
- `logs/realtime/` (realtime session lifecycle logs; JSONL)

Retention:
- Global defaults: `LLM_ADAPTER_LOG_MAX_FILES`, `LLM_ADAPTER_LOG_MAX_AGE_DAYS`
- Per-channel overrides:
  - `LLM_ADAPTER_VOICE_LOG_MAX_FILES`, `LLM_ADAPTER_VOICE_LOG_MAX_AGE_DAYS`, `LLM_ADAPTER_VOICE_LOG_MAX_BYTES`
  - `LLM_ADAPTER_REALTIME_LOG_MAX_FILES`, `LLM_ADAPTER_REALTIME_LOG_MAX_AGE_DAYS`, `LLM_ADAPTER_REALTIME_LOG_MAX_BYTES`

## Redaction

Structured logs are serialized via the `BaseAdapterLogger` JSON replacer.

- Always redacts:
  - `Authorization` header values (keeps last 4 chars)
  - keys ending in `base64` (audio/images/etc)
  - basic-auth credentials and sensitive query params in URL-like strings
- Additionally redacts any key matching `security.redaction.sensitiveKeys` from `plugins/configs/defaults.json` (case-insensitive, supports `*` wildcards).
