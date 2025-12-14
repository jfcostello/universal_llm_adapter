import type {
  AdapterLogger,
  IEmbeddingOperationLogger,
  IVectorOperationLogger,
  LoggerCorrelationId
} from './types.js';

export interface LoggingDeps {
  getLogger: (correlationId?: LoggerCorrelationId) => AdapterLogger;
  getEmbeddingLogger: (correlationId?: LoggerCorrelationId) => IEmbeddingOperationLogger;
  getVectorLogger: (correlationId?: LoggerCorrelationId) => IVectorOperationLogger;
  closeLogger: () => Promise<void>;
}

const noopAsync = async (): Promise<void> => {};
const noop = (): void => {};

function createNoopAdapterLogger(): AdapterLogger {
  const logger: AdapterLogger = {
    withCorrelation: (_correlationId: LoggerCorrelationId) => logger,
    debug: (_message: string, _data?: any) => noop(),
    info: (_message: string, _data?: any) => noop(),
    warning: (_message: string, _data?: any) => noop(),
    error: (_message: string, _data?: any) => noop(),
    logLLMRequest: (_data: any) => noop(),
    logLLMResponse: (_data: any) => noop(),
    close: noopAsync
  };
  return logger;
}

function createNoopEmbeddingLogger(): IEmbeddingOperationLogger {
  return {
    logEmbeddingRequest: (_data: any) => noop(),
    logEmbeddingResponse: (_data: any) => noop()
  };
}

function createNoopVectorLogger(): IVectorOperationLogger {
  return {
    logVectorRequest: (_data: any) => noop(),
    logVectorResponse: (_data: any) => noop()
  };
}

let cachedAdapterLogger: AdapterLogger | null = null;
let cachedEmbeddingLogger: IEmbeddingOperationLogger | null = null;
let cachedVectorLogger: IVectorOperationLogger | null = null;

const noopLoggingDeps: LoggingDeps = {
  getLogger: (_correlationId?: LoggerCorrelationId) =>
    cachedAdapterLogger ?? (cachedAdapterLogger = createNoopAdapterLogger()),
  getEmbeddingLogger: (_correlationId?: LoggerCorrelationId) =>
    cachedEmbeddingLogger ?? (cachedEmbeddingLogger = createNoopEmbeddingLogger()),
  getVectorLogger: (_correlationId?: LoggerCorrelationId) =>
    cachedVectorLogger ?? (cachedVectorLogger = createNoopVectorLogger()),
  closeLogger: async () => {
    cachedAdapterLogger = null;
    cachedEmbeddingLogger = null;
    cachedVectorLogger = null;
  }
};

export function getNoopLogger(): AdapterLogger {
  return noopLoggingDeps.getLogger();
}

export function getNoopEmbeddingLogger(): IEmbeddingOperationLogger {
  return noopLoggingDeps.getEmbeddingLogger();
}

export function getNoopVectorLogger(): IVectorOperationLogger {
  return noopLoggingDeps.getVectorLogger();
}

export function getNoopLoggingDeps(): LoggingDeps {
  return noopLoggingDeps;
}

export function resolveLoggingDeps(overrides: Partial<LoggingDeps> = {}): LoggingDeps {
  return {
    getLogger: overrides.getLogger ?? noopLoggingDeps.getLogger,
    getEmbeddingLogger: overrides.getEmbeddingLogger ?? noopLoggingDeps.getEmbeddingLogger,
    getVectorLogger: overrides.getVectorLogger ?? noopLoggingDeps.getVectorLogger,
    closeLogger: overrides.closeLogger ?? noopLoggingDeps.closeLogger
  };
}
