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
