import {
  BaseAdapterLogger,
  LogLevel,
  LLMLogger,
  EmbeddingLogger,
  VectorLogger
} from './logging/index.js';

let llmLogger: AdapterLogger | null = null;
let embeddingLogger: EmbeddingLogger | null = null;
let vectorLogger: VectorLogger | null = null;

// Re-export building blocks
export { BaseAdapterLogger, LogLevel, LLMLogger, EmbeddingLogger, VectorLogger };

// Backwards-compatible export for legacy consumers
export class AdapterLogger extends LLMLogger {}

export function getLLMLogger(correlationId?: string): LLMLogger {
  if (!llmLogger) {
    llmLogger = new AdapterLogger();
  }
  return correlationId ? llmLogger.withCorrelation(correlationId) : llmLogger;
}

export function getEmbeddingLogger(correlationId?: string): EmbeddingLogger {
  if (!embeddingLogger) {
    embeddingLogger = new EmbeddingLogger();
  }
  return correlationId ? embeddingLogger.withCorrelation(correlationId) : embeddingLogger;
}

export function getVectorLogger(correlationId?: string): VectorLogger {
  if (!vectorLogger) {
    vectorLogger = new VectorLogger();
  }
  return correlationId ? vectorLogger.withCorrelation(correlationId) : vectorLogger;
}

// Legacy entry point returns the LLM logger
export function getLogger(correlationId?: string): AdapterLogger {
  return getLLMLogger(correlationId) as AdapterLogger;
}

export async function closeLogger(): Promise<void> {
  const closers: Promise<void>[] = [];
  if (llmLogger) closers.push(llmLogger.close());
  if (embeddingLogger) closers.push(embeddingLogger.close());
  if (vectorLogger) closers.push(vectorLogger.close());

  await Promise.all(closers);

  llmLogger = null;
  embeddingLogger = null;
  vectorLogger = null;
}
