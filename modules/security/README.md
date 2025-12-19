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
- `createSignedWsToken({ secret, payload })` – creates a signed, compact token for ephemeral auth in WS query params or headers.
- `verifySignedWsToken({ token, secret, expected, nowSeconds, clockSkewSeconds, maxTtlSeconds })` – verifies token signature and time bounds.
