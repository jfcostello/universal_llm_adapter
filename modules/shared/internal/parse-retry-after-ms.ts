export function parseRetryAfterMs(headerValue: unknown, nowMs = Date.now()): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  // Retry-After: <seconds>
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  // Retry-After: <http-date>
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  const deltaMs = dateMs - nowMs;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  return Math.floor(deltaMs);
}
