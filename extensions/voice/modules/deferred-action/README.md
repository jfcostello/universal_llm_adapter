# Deferred Action Module

This module provides a utility for scheduling actions that execute after specific events are received. It's used for graceful mode handling in voice endpoints (end/transfer).

## Purpose

When a voice call needs to end or transfer gracefully (e.g., `after_playback` mode), the action should wait for specific events (like `voice.playback.drained`) before executing. This module encapsulates that event-driven scheduling logic.

## Usage

```typescript
import { scheduleDeferredAction } from '../deferred-action/index.js';

const result = await scheduleDeferredAction({
  callConfigId: 'call-123',
  providerCallId: 'provider-456',
  voiceProvider: 'twilio',
  eventTypes: ['voice.playback.drained', 'user_speech.started'],
  maxWaitMs: 5000,
  cancelOnUserSpeech: true,
  triggerEvents: ['voice.playback.drained'],
  pendingRequests: pendingEndRequests,
  eventsHub: eventsHub,
  execute: async () => {
    await endCall({ ... });
  },
  onScheduled: () => {
    emitCallEvent(callConfigId, { type: 'voice.call.end_scheduled', ... });
  },
  onExecuted: (reason) => {
    emitCallEvent(callConfigId, { type: 'voice.call.end_requested', reason, ... });
  },
  onCanceled: (reason) => {
    emitCallEvent(callConfigId, { type: 'voice.call.end_canceled', reason, ... });
  },
  onFailed: (err, reason) => {
    emitCallEvent(callConfigId, { type: 'voice.call.end_failed', ... });
  }
});

// result is 'scheduled' | 'noop' | 'executed'
```

## Return Values

- `'scheduled'`: Action is waiting for events to trigger execution
- `'noop'`: A pending request already exists for this callConfigId
- `'executed'`: Subscription failed and action was executed immediately (awaited)

## Error Handling

When the events hub rejects subscription (e.g., due to saturation) and the immediate execution fails, the function throws the error so the caller can return an appropriate HTTP error response.

## Files

- `index.ts` - Public API exports
- `internal/scheduler.ts` - Implementation

## Dependencies

This module has no external dependencies. It receives the events hub as a parameter to maintain loose coupling.
