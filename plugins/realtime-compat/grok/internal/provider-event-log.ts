import { setUnrefTimeout } from '../../../../modules/shared/index.js';

function readEnvPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function sanitizeProviderEventForLog(event: any): any {
  if (!event || typeof event !== 'object') return event;
  const cloned = Array.isArray(event) ? [...event] : { ...event };
  const type = String((cloned as any).type ?? '');
  if (type === 'response.output_audio.delta' && typeof (cloned as any).delta === 'string') {
    (cloned as any).delta = '[REDACTED_BASE64]';
  }
  return cloned;
}

export interface ProviderEventLogger {
  start: () => void;
  expire: () => void;
  maybeLog: (event: any) => void;
}

export function createProviderEventLogger(sessionId: string): ProviderEventLogger {
  const providerEventLogWindowMs = readEnvPositiveInt('LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS');
  if (!providerEventLogWindowMs) {
    return { start: () => {}, expire: () => {}, maybeLog: () => {} };
  }

  const providerEventLogMaxQueue = Math.min(
    Math.max(readEnvPositiveInt('LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MAX_QUEUE') ?? 200, 1),
    1000
  );
  const providerEventLogBatchSize = Math.min(
    Math.max(readEnvPositiveInt('LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_BATCH_SIZE') ?? 25, 1),
    providerEventLogMaxQueue
  );

  let providerEventLogUntilMs: number | undefined;
  let providerEventLogExpiryTimer: NodeJS.Timeout | undefined;
  let providerEventLogger: any | undefined;
  let providerEventLoggerLoading: Promise<any> | undefined;

  const getProviderEventLogger = async (): Promise<any | undefined> => {
    if (providerEventLogger) return providerEventLogger;
    if (!providerEventLoggerLoading) {
      providerEventLoggerLoading = (async () => {
        const logging = await import('../../../../modules/logging/index.js');
        return logging.getRealtimeLogger();
      })();
    }
    try {
      providerEventLogger = await providerEventLoggerLoading;
    } catch {
      providerEventLoggerLoading = undefined;
      providerEventLogger = undefined;
    }
    return providerEventLogger;
  };

  const providerEventLogQueue: any[] = [];
  let providerEventLogDroppedDueToQueue = 0;
  let providerEventLogDroppedDueToExpiry = 0;
  let providerEventLogDroppedWarned = false;
  let providerEventLogDrainScheduled = false;
  let providerEventLogDrainInFlight = false;

  const clearProviderEventLogExpiryTimer = () => {
    if (!providerEventLogExpiryTimer) return;
    clearTimeout(providerEventLogExpiryTimer);
    providerEventLogExpiryTimer = undefined;
  };

  const expire = () => {
    if (!providerEventLogUntilMs) return;
    providerEventLogUntilMs = undefined;
    clearProviderEventLogExpiryTimer();
    if (providerEventLogQueue.length > 0) {
      providerEventLogDroppedDueToExpiry += providerEventLogQueue.length;
      providerEventLogQueue.splice(0, providerEventLogQueue.length);
    }
  };

  const scheduleProviderEventDrain = () => {
    if (providerEventLogDrainScheduled || providerEventLogDrainInFlight) return;
    providerEventLogDrainScheduled = true;
    setImmediate(() => {
      providerEventLogDrainScheduled = false;
      void drainProviderEventLogs();
    });
  };

  const maybeWarnDroppedProviderEvents = (logger: any) => {
    if (providerEventLogDroppedWarned) return;
    const droppedTotal = providerEventLogDroppedDueToQueue + providerEventLogDroppedDueToExpiry;
    if (droppedTotal <= 0) return;

    providerEventLogDroppedWarned = true;
    const warn = typeof logger?.warn === 'function' ? logger.warn : logger.info;
    try {
      warn.call(logger, 'realtime.provider_event.dropped', {
        sessionId,
        droppedTotal,
        droppedDueToQueue: providerEventLogDroppedDueToQueue,
        droppedDueToExpiry: providerEventLogDroppedDueToExpiry,
        maxQueue: providerEventLogMaxQueue,
        batchSize: providerEventLogBatchSize
      });
    } catch {
      // best-effort
    }
  };

  const drainProviderEventLogs = async (): Promise<void> => {
    providerEventLogDrainInFlight = true;
    try {
      const logger = await getProviderEventLogger();
      if (typeof logger?.info !== 'function') {
        providerEventLogQueue.splice(0, providerEventLogQueue.length);
        return;
      }

      const until = providerEventLogUntilMs;
      if (until && Date.now() > until) {
        expire();
      }

      maybeWarnDroppedProviderEvents(logger);
      if (!providerEventLogUntilMs) return;

      let drained = 0;
      while (providerEventLogQueue.length > 0 && drained < providerEventLogBatchSize) {
        const currentUntil = providerEventLogUntilMs!;
        if (Date.now() > currentUntil) {
          expire();
          maybeWarnDroppedProviderEvents(logger);
          break;
        }

        const next = providerEventLogQueue.shift();
        try {
          logger.info('realtime.provider_event', { providerEvent: next });
        } catch {
          // best-effort
        }
        drained += 1;
      }
    } catch {
      // best-effort
    } finally {
      providerEventLogDrainInFlight = false;
      if (providerEventLogQueue.length > 0) {
        scheduleProviderEventDrain();
      }
    }
  };

  const maybeLog = (event: any): void => {
    const until = providerEventLogUntilMs;
    if (!until) return;
    const now = Date.now();
    if (now > until) {
      expire();
      if (!providerEventLogDroppedWarned && providerEventLogDroppedDueToQueue + providerEventLogDroppedDueToExpiry > 0) {
        scheduleProviderEventDrain();
      }
      return;
    }

    if (providerEventLogQueue.length >= providerEventLogMaxQueue) {
      providerEventLogDroppedDueToQueue += 1;
      void getProviderEventLogger();
      scheduleProviderEventDrain();
      return;
    }
    void getProviderEventLogger();
    providerEventLogQueue.push(sanitizeProviderEventForLog(event));
    scheduleProviderEventDrain();
  };

  const start = () => {
    providerEventLogUntilMs = Date.now() + providerEventLogWindowMs;
    clearProviderEventLogExpiryTimer();
    providerEventLogExpiryTimer = setUnrefTimeout(() => {
      providerEventLogExpiryTimer = undefined;
      expire();
      if (!providerEventLogDroppedWarned && providerEventLogDroppedDueToQueue + providerEventLogDroppedDueToExpiry > 0) {
        scheduleProviderEventDrain();
      }
    }, providerEventLogWindowMs);
  };

  return { start, expire, maybeLog };
}
