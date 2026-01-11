import { LLMLogger } from './llm-logger.js';
import { EmbeddingLogger } from './embedding-logger.js';
import { VectorLogger } from './vector-logger.js';
import { RealtimeLogger } from './realtime-logger.js';
import type { LoggingDeps } from '../../../kernel/index.js';
import type { LoggerCorrelationId } from '../../../kernel/index.js';

let llmLogger: AdapterLogger | null = null;
let embeddingLogger: EmbeddingLogger | null = null;
let vectorLogger: VectorLogger | null = null;
let realtimeLogger: RealtimeLogger | null = null;

export * from './base-logger.js';
export * from './llm-logger.js';
export * from './embedding-logger.js';
export * from './vector-logger.js';
export * from './json-line-file-logger.js';
export * from './realtime-logger.js';
export * from './retention.js';
export * from './retention-manager.js';

// Backwards-compatible export for legacy consumers
export class AdapterLogger extends LLMLogger {}

export function getLLMLogger(correlationId?: LoggerCorrelationId): LLMLogger {
  if (!llmLogger) {
    llmLogger = new AdapterLogger();
  }
  return correlationId ? llmLogger.withCorrelation(correlationId) : llmLogger;
}

export function getEmbeddingLogger(correlationId?: LoggerCorrelationId): EmbeddingLogger {
  if (!embeddingLogger) {
    embeddingLogger = new EmbeddingLogger();
  }
  return correlationId ? embeddingLogger.withCorrelation(correlationId) : embeddingLogger;
}

export function getVectorLogger(correlationId?: LoggerCorrelationId): VectorLogger {
  if (!vectorLogger) {
    vectorLogger = new VectorLogger();
  }
  return correlationId ? vectorLogger.withCorrelation(correlationId) : vectorLogger;
}

export function getRealtimeLogger(correlationId?: LoggerCorrelationId): RealtimeLogger {
  if (!realtimeLogger) {
    realtimeLogger = new RealtimeLogger();
  }
  return correlationId ? realtimeLogger.withCorrelation(correlationId) : realtimeLogger;
}

// Legacy entry point returns the LLM logger
export function getLogger(correlationId?: LoggerCorrelationId): AdapterLogger {
  return getLLMLogger(correlationId) as AdapterLogger;
}

export async function closeLogger(): Promise<void> {
  const closers: Promise<void>[] = [];
  if (llmLogger) closers.push(llmLogger.close());
  if (embeddingLogger) closers.push(embeddingLogger.close());
  if (vectorLogger) closers.push(vectorLogger.close());
  if (realtimeLogger) closers.push(realtimeLogger.close());

  await Promise.all(closers);

  llmLogger = null;
  embeddingLogger = null;
  vectorLogger = null;
  realtimeLogger = null;
}

export function createLoggingDeps(): LoggingDeps {
  return {
    getLogger,
    getEmbeddingLogger,
    getVectorLogger,
    closeLogger
  };
}
