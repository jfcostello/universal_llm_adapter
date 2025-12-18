# `modules/security`

Small, dependency-free security helpers used across the library.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/security/index.ts` (tests may import internals).

## Exports

### Header Redaction
- `genericRedactHeaders(headers)` – masks sensitive values in commonly used headers (`Authorization`, `x-api-key`). Shows only the last 4 characters (e.g., `Bearer ***7890`).

### URL Redaction
- `redactUrlCredentials(url)` – redacts basic-auth credentials in URLs (e.g., `https://user:pass@host` → `https://***:***@host`).
- `redactUrlQueryParams(url, sensitiveParams?)` – redacts sensitive query parameters in URLs. Shows only the last 4 characters of sensitive values (e.g., `?key=AIzaSy1234` → `?key=***1234`). Default sensitive params: `key`, `api_key`, `apikey`, `token`, `secret`, `password`, `auth`, `credential`. Case-insensitive matching. Pass custom `sensitiveParams` array to override defaults.
- `redactUrl(url)` – combines `redactUrlCredentials` and `redactUrlQueryParams` for full URL redaction.

### Signed WebSocket Tokens
- `signWsToken(payload, secret, options?)` – creates a signed token for WebSocket authentication.
- `verifyWsToken(token, secret, options?)` – verifies and decodes a signed WebSocket token.

## Usage Examples

```typescript
import { redactUrl, redactUrlQueryParams } from '@/modules/security';

// Redact Gemini-style API key in query string
const geminiUrl = 'wss://generativelanguage.googleapis.com/ws/live?key=AIzaSyABCD1234';
console.log(redactUrl(geminiUrl));
// Output: wss://generativelanguage.googleapis.com/ws/live?key=***1234

// Redact multiple sensitive params
const url = 'https://api.example.com?token=secret123&model=gpt-4';
console.log(redactUrlQueryParams(url));
// Output: https://api.example.com/?token=***t123&model=gpt-4

// Custom sensitive params
const customUrl = 'https://api.example.com?mySecret=abc123&key=keep-this';
console.log(redactUrlQueryParams(customUrl, ['mySecret']));
// Output: https://api.example.com/?mySecret=***c123&key=keep-this
```
