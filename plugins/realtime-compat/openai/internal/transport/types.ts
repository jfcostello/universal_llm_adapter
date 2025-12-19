import type { AsyncQueue } from '../../../../../modules/kernel/index.js';

export type RealtimeTransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; error: unknown; code?: string }
  | { type: 'close' };

export interface IRealtimeTransport {
  send: (data: string) => void;
  events: () => AsyncIterable<RealtimeTransportEvent>;
  close: () => void;
}

export type TransportQueue = AsyncQueue<RealtimeTransportEvent>;
