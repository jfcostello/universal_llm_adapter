# Graceful Mode Validation Module

This module provides validation utilities for graceful mode parameters used in voice call end/transfer endpoints.

## Purpose

When ending or transferring voice calls, the server supports graceful modes that wait for specific events (like playback completion) before executing. This module validates the mode parameters, timeout values, and cancellation flags used by both CLI and server implementations.

## Types

### `GracefulEndMode`
Valid modes for graceful call ending:
- `'immediate'` - End the call immediately
- `'after_assistant_audio'` - Wait for assistant audio to finish
- `'after_playback'` - Wait for playback to drain

### `GracefulTransferMode`
Valid modes for graceful call transfer:
- `'immediate'` - Transfer the call immediately
- `'after_playback'` - Wait for playback to drain before transferring

## Functions

### `validateEndMode(raw, defaultMode)`
Validates and returns an end mode.
- Throws `HttpError` with 400 status if mode is invalid

### `validateTransferMode(raw, defaultMode)`
Validates and returns a transfer mode.
- Throws `HttpError` with 400 status if mode is invalid

### `validateMaxWaitMs(raw, defaultValue, limit?)`
Validates and returns the maxWaitMs timeout value.
- Returns `defaultValue` if raw is empty
- Throws `HttpError` with 400 status if value is negative or exceeds limit

### `validateCancelOnUserSpeechCli(raw, defaultValue)`
CLI-specific validation for the cancelOnUserSpeech flag.
- Accepts string values: `'true'`, `'1'`, `'yes'`, `'y'`, `'on'` (truthy) and `'false'`, `'0'`, `'no'`, `'n'`, `'off'` (falsy)
- Returns `undefined` if raw is empty (to skip including in request)
- Throws `HttpError` with 400 status if value is unrecognized

### `validateCancelOnUserSpeechServer(raw, defaultValue)`
Server-side validation for the cancelOnUserSpeech flag.
- Uses `normalizeFlag` from shared module for standard boolean coercion

## Usage

```typescript
import {
  validateEndMode,
  validateTransferMode,
  validateMaxWaitMs,
  validateCancelOnUserSpeechCli,
  validateCancelOnUserSpeechServer,
  type GracefulEndMode,
  type GracefulTransferMode
} from '../graceful-mode-validation/index.js';

// Server endpoint
const mode = validateEndMode(body?.mode, 'immediate');
const maxWaitMs = validateMaxWaitMs(body?.maxWaitMs, 5000, 60000);
const cancelOnUserSpeech = validateCancelOnUserSpeechServer(body?.cancelOnUserSpeech, false);

// CLI command
const mode = validateTransferMode(options.mode, 'immediate');
const maxWaitMs = validateMaxWaitMs(options.maxWaitMs, 5000); // no limit for CLI
const cancelOnUserSpeech = validateCancelOnUserSpeechCli(options.cancelOnUserSpeech, false);
```

## Files

- `index.ts` - Public API exports
- `internal/validation.ts` - Implementation

## Dependencies

- `modules/shared` - Uses `makeHttpError` for error creation and `normalizeFlag` for boolean coercion
