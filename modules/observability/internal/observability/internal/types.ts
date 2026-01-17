import type { ObservabilityLLMRequestEvent, ObservabilityLLMResponseEvent } from '../../../../../kernel/index.js';

export interface QueuedEvent {
  id: string;
  type: 'llm_request' | 'llm_response';
  data: ObservabilityLLMRequestEvent | ObservabilityLLMResponseEvent;
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

