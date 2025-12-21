// Realtime module public surface (provider-agnostic).
// Provider-specific realtime logic must live under plugins/realtime-compat/*.

export type { RealtimeSession } from './internal/realtime-session.js';
export { createRealtimeSession } from './internal/create-session.js';
export { createWsTransport } from './internal/transport/ws.js';

// Re-export spec and event types for convenience.
export type {
  RealtimeSessionSpec,
  RealtimeHistoryItem,
  RealtimeAudioFrame,
  RealtimeEvent
} from '../kernel/index.js';
