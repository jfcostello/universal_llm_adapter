export function createAudioRateLimiter(maxBytesPerSecond: number): {
  charge: (bytes: number) => void;
  reset: () => void;
} {
  let tokens = maxBytesPerSecond;
  let lastRefillMs = Date.now();

  const reset = () => {
    tokens = maxBytesPerSecond;
    lastRefillMs = Date.now();
  };

  const charge = (bytes: number) => {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastRefillMs);
    const refill = (elapsedMs * maxBytesPerSecond) / 1000;
    tokens = Math.min(maxBytesPerSecond, tokens + refill);
    lastRefillMs = now;

    if (tokens < bytes) {
      throw Object.assign(new Error('Audio rate limit exceeded'), { code: 'audio_rate_limited' });
    }
    tokens -= bytes;
  };

  return { charge, reset };
}

