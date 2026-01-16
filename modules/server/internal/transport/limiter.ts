export interface LimiterOptions {
  maxConcurrent: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

interface QueueItem {
  resolve: (release: () => void) => void;
  reject: (error: any) => void;
  timeoutId?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
  node?: QueueNode;
}

interface QueueNode {
  item: QueueItem;
  prev?: QueueNode;
  next?: QueueNode;
}

class LinkedQueue {
  private head: QueueNode | undefined;
  private tail: QueueNode | undefined;
  private length = 0;

  getLength(): number {
    return this.length;
  }

  push(node: QueueNode): void {
    if (!this.tail) {
      this.head = node;
      this.tail = node;
      this.length = 1;
      return;
    }

    node.prev = this.tail;
    this.tail.next = node;
    this.tail = node;
    this.length += 1;
  }

  shift(): QueueNode | undefined {
    const node = this.head;
    if (!node) return undefined;

    const next = node.next;
    this.head = next;
    if (next) {
      next.prev = undefined;
    } else {
      this.tail = undefined;
    }

    node.next = undefined;
    node.prev = undefined;
    this.length = Math.max(0, this.length - 1);
    return node;
  }

  remove(node: QueueNode): void {
    const prev = node.prev;
    const next = node.next;

    if (prev) prev.next = next;
    else this.head = next;

    if (next) next.prev = prev;
    else this.tail = prev;

    node.next = undefined;
    node.prev = undefined;
    this.length = Math.max(0, this.length - 1);
  }
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
  const queue = new LinkedQueue();

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
    while (inFlight < maxConcurrent) {
      const node = queue.shift();
      if (!node) return;
      const item = node.item;
      item.node = undefined;

      if (item.timeoutId) clearTimeout(item.timeoutId);
      if (item.signal && item.abortHandler) {
        try {
          item.signal.removeEventListener('abort', item.abortHandler);
        } catch {}
      }

      inFlight += 1;
      item.resolve(releaseFactory());
    }
  }

  function cancelItem(item: QueueItem, error: any) {
    if (item.timeoutId) clearTimeout(item.timeoutId);
    if (item.signal && item.abortHandler) {
      try {
        item.signal.removeEventListener('abort', item.abortHandler);
      } catch {}
    }
    if (item.node) {
      queue.remove(item.node);
      item.node = undefined;
    }
    item.reject(error);
  }

  async function acquire(signal?: AbortSignal): Promise<() => void> {
    if (maxConcurrent === Number.POSITIVE_INFINITY) {
      if (signal?.aborted) {
        throw makeError('Client disconnected', 'client_aborted', 499);
      }
      return () => {};
    }

    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return releaseFactory();
    }

    if (maxQueueSize === 0 || queue.getLength() >= maxQueueSize) {
      throw makeError('Server busy', 'server_busy', 503);
    }

    return new Promise<() => void>((resolve, reject) => {
      const item: QueueItem = { resolve, reject, signal };
      const node: QueueNode = { item };
      item.node = node;

      if (signal) {
        if (signal.aborted) {
          reject(makeError('Client disconnected', 'client_aborted', 499));
          return;
        }
        item.abortHandler = () =>
          cancelItem(item, makeError('Client disconnected', 'client_aborted', 499));
        signal.addEventListener('abort', item.abortHandler, { once: true });
      }

      if (queueTimeoutMs > 0) {
        item.timeoutId = setTimeout(() => {
          cancelItem(item, makeError('Queue wait timed out', 'queue_timeout', 503));
        }, queueTimeoutMs);
      }

      queue.push(node);
    });
  }

  return { acquire };
}
