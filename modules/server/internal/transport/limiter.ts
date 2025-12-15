export interface LimiterOptions {
  maxConcurrent: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

interface QueueItem {
  resolve: (release: () => void) => void;
  reject: (error: any) => void;
  timeoutId?: NodeJS.Timeout;
  canceled?: boolean;
  signal?: AbortSignal;
}

function makeError(message: string, code: string, statusCode: number) {
  const error = new Error(message);
  (error as any).code = code;
  (error as any).statusCode = statusCode;
  return error;
}

export function createLimiter(options: LimiterOptions) {
  const maxConcurrent =
    !Number.isFinite(options.maxConcurrent) || options.maxConcurrent <= 0
      ? Number.POSITIVE_INFINITY
      : options.maxConcurrent;
  const maxQueueSize = Math.max(0, options.maxQueueSize ?? 0);
  const queueTimeoutMs = Math.max(0, options.queueTimeoutMs ?? 0);

  let inFlight = 0;
  const queue: QueueItem[] = [];

  function releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      processQueue();
    };
  }

  function processQueue() {
    while (queue.length > 0 && inFlight < maxConcurrent) {
      const item = queue.shift()!;
      if (item.canceled) continue;
      if (item.timeoutId) clearTimeout(item.timeoutId);

      inFlight += 1;
      item.resolve(releaseFactory());
      return;
    }
  }

  function cancelItem(item: QueueItem, error: any) {
    item.canceled = true;
    if (item.timeoutId) clearTimeout(item.timeoutId);
    item.reject(error);
  }

  async function acquire(signal?: AbortSignal): Promise<() => void> {
    if (maxConcurrent === Number.POSITIVE_INFINITY) {
      return () => {};
    }

    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return releaseFactory();
    }

    if (maxQueueSize === 0 || queue.length >= maxQueueSize) {
      throw makeError('Server busy', 'server_busy', 503);
    }

    return new Promise<() => void>((resolve, reject) => {
      const item: QueueItem = { resolve, reject, signal };

      if (signal) {
        if (signal.aborted) {
          reject(makeError('Client disconnected', 'client_aborted', 499));
          return;
        }
        signal.addEventListener(
          'abort',
          () => cancelItem(item, makeError('Client disconnected', 'client_aborted', 499)),
          { once: true }
        );
      }

      if (queueTimeoutMs > 0) {
        item.timeoutId = setTimeout(() => {
          cancelItem(item, makeError('Queue wait timed out', 'queue_timeout', 503));
          // Remove from queue if still present
          const idx = queue.indexOf(item);
          if (idx >= 0) queue.splice(idx, 1);
        }, queueTimeoutMs);
      }

      queue.push(item);
    });
  }

  return { acquire };
}
