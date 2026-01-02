export function setUnrefTimeout(
  callback: () => void,
  ms: number
): ReturnType<typeof setTimeout> {
  const timeoutId = setTimeout(callback, ms);
  const unref = (timeoutId as any)?.unref;
  if (typeof unref === 'function') {
    try {
      unref.call(timeoutId);
    } catch {
      // best-effort
    }
  }
  return timeoutId;
}

