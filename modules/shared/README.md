# `modules/shared`

Lightweight shared utilities module for small, reusable functions that don't warrant their own dedicated module.

## Purpose

This module exists to:
- Avoid code duplication across lazy-loaded modules
- Provide a home for utilities too small for their own module
- Keep kernel lean (kernel is always loaded; shared is lazy-loaded)

## Size Policy

| Utility Size | Location |
|--------------|----------|
| Tiny (<30 lines) | Add directly to `index.ts` |
| Medium (30-100 lines) | Add as `internal/feature.ts` and re-export from `index.ts` |
| Large (>100 lines or multiple files) | Create dedicated module in `modules/` |

## When to Use This Module

**Add here if:**
- Function is used by 2+ lazy-loaded modules
- Function is generic (not domain-specific)
- Function is small and unlikely to grow complex

**Create dedicated module if:**
- Functionality requires multiple files
- Has its own types/interfaces
- Represents a distinct domain concept

## Exports

### `normalizeFlag(value, defaultValue)`

Normalizes various input types to a boolean flag.

```typescript
import { normalizeFlag } from '../shared/index.js';

normalizeFlag(true, false);      // true
normalizeFlag('yes', false);     // true
normalizeFlag('1', false);       // true
normalizeFlag('off', true);      // false
normalizeFlag(null, true);       // true (default)
normalizeFlag('maybe', false);   // false (unrecognized → default)
```

**Accepted values:**
- `boolean` → returned as-is
- `number` → converted via `Boolean()`
- `string` → `'true'/'1'/'yes'/'y'/'on'` → true, `'false'/'0'/'no'/'n'/'off'` → false
- `null/undefined` → returns `defaultValue`
- other → converted via `Boolean()`

### `createDeferred<T>()`

Creates a deferred promise with externally accessible resolve/reject handlers.
Equivalent to the ES2024 `Promise.withResolvers()` API.

```typescript
import { createDeferred } from '../shared/index.js';

// Basic usage (void)
const signal = createDeferred();
setTimeout(() => signal.resolve(), 1000);
await signal.promise;

// With value type
const deferred = createDeferred<string>();
deferred.resolve('hello');
const value = await deferred.promise; // 'hello'

// Error handling
const failing = createDeferred<number>();
failing.reject(new Error('oops'));
await failing.promise; // throws Error('oops')
```

**Returns:** `Deferred<T>` object with:
- `promise` - The Promise instance
- `resolve(value: T)` - Function to resolve the promise
- `reject(reason?: unknown)` - Function to reject the promise

### `sleep(ms)`

Sleep for a specified duration.

```typescript
import { sleep } from '../shared/index.js';

await sleep(250);
```

### `calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs)`

Calculate an exponential backoff delay with jitter (+/- 25%), capped at `maxDelayMs`.

```typescript
import { calculateBackoffDelay } from '../shared/index.js';

const delayMs = calculateBackoffDelay(2, 250, 30_000);
```
