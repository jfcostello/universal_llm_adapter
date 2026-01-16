## Transport module

Shared, provider-agnostic transport utilities used by both the server and CLI layers.

### Purpose

- Keep **structured error mapping** and **spec validation** in a single place.
- Avoid the CLI importing server-only modules for request validation and error formatting.
- Ensure CLI and server stay in parity for validation rules and error envelope shape.

### Exports

- `mapErrorToHttp(error, options?)` → `{ status, body }` where `body` is the structured `{ type: "error", error: { message, code, details? } }` envelope.
  - `options.redactServerErrors` (boolean, default `true`) – when true, 5xx messages are generic (`Server error`, `Upstream error`, etc).
- `assertValidSpec(spec)` → throws a structured validation error on invalid LLM call specs.
- `assertValidVectorSpec(spec)` → throws a structured validation error on invalid vector specs.
- `assertValidEmbeddingSpec(spec)` → throws a structured validation error on invalid embedding specs.

### Notes

- This module must remain **provider-agnostic** and safe to lazy-load.
- Validation uses Ajv; schemas are intentionally permissive for unknown/extra fields, while enforcing required shapes for core fields.
