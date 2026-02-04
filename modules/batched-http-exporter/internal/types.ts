import type { AdapterLogger } from '../../../kernel/index.js';

export interface BatchedHttpExporterConfig {
  provider: string;
  logger?: AdapterLogger;
  providerConfig?: Record<string, unknown>;
  flushAt: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  maxAttributeValueBytes?: number;
}

export interface QueuedExportEvent<TType extends string = string, TData = unknown> {
  id: string;
  type: TType;
  data: TData;
  timestamp: number;
  attempts: number;
}

export interface BatchedHttpExporterMetrics {
  enqueuedTotal: number;
  droppedTotal: number;
  flushCount: number;
  flushMsTotal: number;
  retryCount: number;
  sentCount: number;
  failedCount: number;
}
