# `modules/security`

Small, dependency-free security helpers used across the library.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/security/index.ts` (tests may import internals).

## Exports
- `genericRedactHeaders(headers)` – masks sensitive values in commonly used headers.
- `redactUrlCredentials(url)` – redacts basic-auth credentials in URLs (e.g. `https://user:pass@host`).
- `redactUrlQueryCredentials(url, sensitiveParams?)` – redacts sensitive query-string credentials (e.g. `?key=...`) and shows only the last 4 characters.
- `redactUrlQueryParams(url, sensitiveParams?)` – alias of `redactUrlQueryCredentials`.
- `redactUrl(url)` – combines basic-auth and query-string redaction.
- `redactJsonCredentials(value, sensitiveKeys?)` – redacts credentials in JSON-like objects/arrays (by key name + URL parsing).
- `createSensitiveKeyMatcher(patterns)` – builds a case-insensitive key matcher with glob-style `*` wildcards.
- `redactSensitiveString(value)` / `redactSensitiveValue(value)` – helpers used by the redaction pipeline.
- `safeEqual(a, b)` – constant-time string compare helper for secrets (wrapper around `crypto.timingSafeEqual`).
- `createSignedWsToken({ secret, payload })` – creates a signed, compact token for ephemeral auth in WS query params or headers.
- `verifySignedWsToken({ token, secret, expected, nowSeconds, clockSkewSeconds, maxTtlSeconds })` – verifies token signature and time bounds.

## Redaction Configuration

Key-based redaction is controlled by `security.redaction.sensitiveKeys` in `plugins/configs/defaults.json`.

- Matching is case-insensitive.
- Patterns can include `*` wildcards (glob-style).
- Defaults include wildcard patterns for api-key-ish keys (e.g. `*api_key*`, `*api-key*`, `*apikey*`) so nested keys like `vendorApiKey` are redacted.
- Defaults include explicit patterns for common token-credential keys (e.g. `access_token`, `refresh_token`, `id_token` variants) without using broad token substring matches.
- By default, we do **not** redact fields just because the key contains `"token"` (token usage counters are common in LLM payloads).

Example:

```json
{
  "security": {
    "redaction": {
      "sensitiveKeys": ["authorization", "x-api-key", "api_key", "*token*"]
    }
  }
}
```
