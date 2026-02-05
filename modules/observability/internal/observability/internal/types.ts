import type { ObservabilityEvent } from '../../../../../kernel/index.js';

export interface QueuedEvent {
  id: string;
  type: ObservabilityEvent['type'];
  data: ObservabilityEvent;
  timestamp: number;
  attempts: number;
}

export interface ObservabilityExporterMetrics {
  enqueuedTotal: number;
  droppedTotal: number;
  flushCount: number;
  flushMsTotal: number;
  retryCount: number;
  sentCount: number;
  failedCount: number;
}
