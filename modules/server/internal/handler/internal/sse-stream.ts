import type http from 'http';

import { writeSseEventWithBackpressure } from '../../streaming/sse.js';

export async function handleSseStream<E>(options: {
  iterator: AsyncIterator<E>;
  res: http.ServerResponse;
  startTimeMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
}): Promise<void> {
  const { iterator, res, startTimeMs, requestTimeoutMs, idleTimeoutMs } = options;

  let lastEventAt = Date.now();
  let finished = false;

  const sendTimeoutAndClose = async (code: string, message: string) => {
    finished = true;
    await writeSseEventWithBackpressure(res, {
      type: 'error',
      error: { message, code }
    });
    res.end();
    // Best-effort: do not await iterator.return() since it can hang if the
    // underlying generator is blocked. Still swallow sync throws and async rejections.
    try {
      const result = iterator.return?.(undefined);
      if (result && typeof (result as any).catch === 'function') {
        (result as any).catch(() => {});
      }
    } catch {
      // ignore
    }
  };

  while (!finished) {
    const now = Date.now();
    const remainingIdleMs =
      idleTimeoutMs > 0
        ? Math.max(0, idleTimeoutMs - (now - lastEventAt))
        : Number.POSITIVE_INFINITY;
    const remainingRequestMs =
      requestTimeoutMs > 0
        ? Math.max(0, requestTimeoutMs - (now - startTimeMs))
        : Number.POSITIVE_INFINITY;
    const waitMs = Math.min(remainingIdleMs, remainingRequestMs);

    const timeoutType = remainingRequestMs <= remainingIdleMs ? 'request' : 'idle';

    let timeoutId: NodeJS.Timeout | undefined;
    const raced: any =
      waitMs === Number.POSITIVE_INFINITY
        ? { result: await iterator.next() }
        : await (async () => {
            try {
              return await Promise.race([
                iterator.next().then(result => ({ result })),
                new Promise(resolve => {
                  timeoutId = setTimeout(() => resolve({ timeout: true }), waitMs);
                })
              ]);
            } finally {
              if (timeoutId !== undefined) clearTimeout(timeoutId);
            }
          })();

    if (raced.timeout) {
      if (timeoutType === 'request') {
        await sendTimeoutAndClose('timeout', 'Request timed out');
      } else {
        await sendTimeoutAndClose('stream_idle_timeout', 'Stream idle timeout');
      }
      break;
    }

    const { value, done } = raced.result as IteratorResult<E>;
    if (done) {
      finished = true;
      break;
    }

    lastEventAt = Date.now();
    await writeSseEventWithBackpressure(res, value);
  }
}
