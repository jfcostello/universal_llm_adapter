export function createTimeout(
  seconds: number,
  options: {
    signal?: AbortSignal;
    onTimeout?: () => void;
  } = {}
): Promise<never> {
  return new Promise((_, reject) => {
    if (options.signal?.aborted) {
      return;
    }

    const timeoutId = setTimeout(() => {
      options.onTimeout?.();
      reject(new Error(`Tool execution timeout after ${seconds}s`));
    }, seconds * 1000);

    if (options.signal) {
      const onAbort = () => {
        clearTimeout(timeoutId);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
