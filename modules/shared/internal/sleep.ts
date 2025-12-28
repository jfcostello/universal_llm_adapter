export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }

  const durationMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (durationMs === 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(true);
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
