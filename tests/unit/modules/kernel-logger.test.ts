import { jest } from '@jest/globals';
import {
  getNoopLogger,
  getNoopEmbeddingLogger,
  getNoopVectorLogger,
  getNoopLoggingDeps
} from '@/modules/kernel/index.ts';

describe('modules/kernel logger helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('noop loggers expose expected methods', async () => {
    const logger = getNoopLogger();

    logger.debug('debug', { a: 1 });
    logger.info('info', { a: 1 });
    logger.warning('warning', { a: 1 });
    logger.error('error', { a: 1 });

    logger.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: {} });
    logger.logLLMResponse({ status: 200, headers: {}, body: {} });

    logger.withCorrelation('corr-1');
    logger.withCorrelation(['corr-1', 'corr-2']);

    await logger.close();

    const embeddingLogger = getNoopEmbeddingLogger();
    embeddingLogger.logEmbeddingRequest({ url: 'http://x', method: 'POST', headers: {}, body: {} });
    embeddingLogger.logEmbeddingResponse({ status: 200, headers: {}, body: {} });

    const vectorLogger = getNoopVectorLogger();
    vectorLogger.logVectorRequest({ operation: 'query', store: 's', params: {} });
    vectorLogger.logVectorResponse({ operation: 'query', store: 's', result: {} });
  });

  test('noop logging deps reset cached logger on close', async () => {
    const deps = getNoopLoggingDeps();

    const first = deps.getLogger();
    await deps.closeLogger();
    const second = deps.getLogger();

    expect(second).not.toBe(first);
  });
});

