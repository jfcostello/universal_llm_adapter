# `modules/auth`

Enterprise-grade, performance-first request authentication primitives.

## Purpose
This module provides pluggable authentication strategies intended to protect the
adapter’s access surface (HTTP/SSE + WS upgrades) in cloud deployments.

Design principles:
- No per-request network calls on the hot path
- O(1) lookups where possible
- Stable `AuthContext` output used for rate limiting and policy decisions

## Public API

### `createAuthenticator(config)`
Returns an object with:
- `authenticate(req): Promise<AuthContext>` – validates credentials and returns an auth context.

### `AuthContext`
Minimal identity context:
- `mode` – auth mode used
- `subject` – stable identity string (when authenticated)

## Modes
- `none` – no authentication (useful for local/dev).
- `apiKey` – shared-secret token auth (supports Bearer + custom header).
- `jwt` – offline JWT validation (signature + claims) with cached JWKS.
- `proxySigned` – gateway-signed identity headers (fastest at very high RPS).

### `apiKey`
Config (`ApiKeyAuthConfig`):
- `allowBearer` (default `true`) – accept `Authorization: Bearer <token>`
- `allowHeader` (default `true`) – accept `headerName: <token>`
- `headerName` (default `x-api-key`)
- `realm` (optional) – used in `WWW-Authenticate`
- `keys` (required) – array of `{ id, token? , sha256? }` (exactly one of `token` or `sha256`)

Server convenience: when used via `modules/server`, if `auth.mode="apiKey"` and `auth.keys` is missing,
the server can load keys from `LLM_ADAPTER_API_KEYS` (comma-separated). Supported entry formats:
- `<token>`
- `<id>:<token>` / `<id>=<token>`
- `<id>:sha256:<hex>` / `<id>=sha256:<hex>`
- `<id>:<64-hex>` / `<id>=<64-hex>` (treated as sha256)

### `jwt`
Config (`JwtAuthConfig`) highlights:
- Credential extraction: `allowBearer`, `allowHeader`, `headerName`, `realm`
- Key material: `jwksUrl` (recommended) or inline `jwks`
- Claim enforcement: `issuer`, `audience`, `algorithms`, `requireExp`, `requireSubject`
- Mapping: `subjectClaim`, `tenantClaim`, `scopesClaim`, `scopesSeparator`
- Bounded verification cache: `cacheMaxEntries` (optional)

JWKS fetches are cached; token verification does not perform network calls on the hot path.

### `proxySigned`
Config (`ProxySignedAuthConfig`) highlights:
- Shared secrets: `keys: [{ id, secret }]`
- Headers: `headers.signature`, `headers.keyId`, `headers.timestamp` (and optional `subject`, `tenant`, `scopes`)
- Clock skew: `maxSkewSeconds`

Intended usage: terminate user auth at an API gateway, then forward a signed identity to this server.
This avoids JWT verification work per request at very high throughput.
