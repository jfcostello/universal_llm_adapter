# `extensions/voice/internal/call-config-store`

Extension-owned store for per-call voice configuration.

Why it exists:
- system prompts can be arbitrarily large (so they cannot be reliably carried in query params or provider webhook parameters)
- horizontally scaled voice services need a shared store (in-memory is dev-only)

This module provides:
- `VoiceCallConfigStore` interface
- in-memory implementation (`createInMemoryVoiceCallConfigStore`)
- Redis implementation (`createRedisVoiceCallConfigStore`, requires a Redis client)

## Redis client interface
`createRedisVoiceCallConfigStore` accepts a minimal `RedisClientLike`:
- required: `get`, `set`, `del`
- optional (debug tooling only, never used by the store): `ttl`, `scan`, `keys`
