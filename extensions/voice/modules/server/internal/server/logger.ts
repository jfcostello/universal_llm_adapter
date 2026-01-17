import type { VoiceLogger, VoiceLogging } from './types.js';

export function createVoiceLoggerResolver(options: { logging?: VoiceLogging }) {
  let cachedVoiceLoggingModule:
    | { getVoiceLogger: (correlationId?: string) => VoiceLogger; closeVoiceLogger: () => Promise<void> }
    | undefined;

  const resolveLogger = async (correlationId?: string): Promise<VoiceLogger | undefined> => {
    if (options.logging?.getLogger) {
      try {
        // Await to properly catch rejected promises (not just synchronous throws)
        return await options.logging.getLogger(correlationId);
      } catch {
        return undefined;
      }
    }

    try {
      if (!cachedVoiceLoggingModule) {
        cachedVoiceLoggingModule = await import('../../../logger/index.js');
      }
      return cachedVoiceLoggingModule.getVoiceLogger(correlationId);
    } catch {
      return undefined;
    }
  };

  const safeLog = (
    logger: VoiceLogger | undefined,
    level: 'debug' | 'info' | 'warning' | 'error',
    message: string,
    data?: any
  ): void => {
    try {
      const fn = logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
  };

  const close = async () => {
    try {
      await cachedVoiceLoggingModule?.closeVoiceLogger?.();
    } catch {}
  };

  return { resolveLogger, safeLog, close };
}

