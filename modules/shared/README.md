# `modules/shared`

Lightweight shared utilities module for small, reusable functions that don't warrant their own dedicated module.

## Purpose

This module exists to:
- Avoid code duplication across lazy-loaded modules
- Provide a home for utilities too small for their own module
- Keep kernel lean (kernel is always loaded; shared is lazy-loaded)

## Structure Policy

`modules/shared/index.ts` is **export-only**. All implementations live under `modules/shared/internal/*` and are re-exported from `index.ts`.

If a shared utility grows into a distinct domain concept (types, multiple files, complex behavior), promote it into a dedicated module under `modules/`.

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

### `sleepWithSignal(ms, signal?)`

Sleep for a specified duration, but resolve early if the provided `AbortSignal` is aborted.

```typescript
import { sleepWithSignal } from '../shared/index.js';

const abortController = new AbortController();
const completed = await sleepWithSignal(5000, abortController.signal);
// completed === false if aborted before 5s elapses
```

### `isPlainObject(value)`

Checks whether a value is a "plain" object (prototype is `Object.prototype` or `null`), suitable for JSON-style payload validation.

```typescript
import { isPlainObject } from '../shared/index.js';

isPlainObject({}); // true
isPlainObject(Object.create(null)); // true
isPlainObject([]); // false
isPlainObject(new Date()); // false
```

### `setUnrefTimeout(callback, ms)`

Sets a timeout and (when supported) calls `.unref()` so it won’t keep the Node.js process alive.

```typescript
import { setUnrefTimeout } from '../shared/index.js';

setUnrefTimeout(() => {
  // ...
}, 1000);
```

### `monotonicNowNs()` / `monotonicElapsedMs(startNs, endNs?)`

Monotonic timing helpers for duration deltas. Use epoch timestamps (`Date.now()`) for `timestampMs` fields and monotonic deltas for `durationMs`/`duration` fields.

```typescript
import { monotonicNowNs, monotonicElapsedMs } from '../shared/index.js';

const start = monotonicNowNs();
// ...do work...
const durationMs = monotonicElapsedMs(start);
```

### `calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs)`

Calculate an exponential backoff delay with jitter (+/- 25%), capped at `maxDelayMs`.

```typescript
import { calculateBackoffDelay } from '../shared/index.js';

const delayMs = calculateBackoffDelay(2, 250, 30_000);
```

### `emitManifestOverrideWarning(warn, area, id, previousSource, nextSource)`

Emits a warning when a manifest is being overridden by another manifest with the same ID. Used by extensions (e.g., voice extension) for consistent warn+override behavior. Note: The core plugin registry in the kernel has its own implementation to avoid dependency on lazy-loaded modules.

The warn+override pattern allows users to provide custom manifests that override built-in defaults - later roots override earlier roots.

```typescript
import { emitManifestOverrideWarning } from '../shared/index.js';

// Called when a duplicate manifest ID is found
emitManifestOverrideWarning(
  (msg, data) => console.warn(msg, data),
  'voice.provider_plugins',
  'my-provider',
  '/builtin/providers/my-provider.json',
  '/custom/providers/my-provider.json'
);
// Warns: "voice.provider_plugins.override" with data { id, previous, next }
```

**Parameters:**
- `warn` - Warning function `(message: string, data: Record<string, unknown>) => void`
- `area` - The manifest area (e.g., 'providers', 'voice.provider_plugins')
- `id` - The manifest ID being overridden
- `previousSource` - Path/info for the previous manifest
- `nextSource` - Path/info for the new (overriding) manifest
