import type http from 'http';

export interface RateLimitConfig {
  enabled: boolean;
  requestsPerMinute: number;
  burst: number;
  trustProxyHeaders?: boolean;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

function makeRateLimitError() {
  const err = new Error('Rate limit exceeded');
  (err as any).statusCode = 429;
  (err as any).code = 'rate_limited';
  return err;
}

export function createRateLimiter(config: Partial<RateLimitConfig>) {
  if (!config?.enabled) {
    return { check: (_key: string) => {} };
  }

  const requestsPerMinute = Math.max(0, Number(config.requestsPerMinute ?? 0));
  const burst = Math.max(1, Number(config.burst ?? 1));
  const refillPerMs = requestsPerMinute / 60000;

  const buckets = new Map<string, Bucket>();

  function refill(bucket: Bucket) {
    const now = Date.now();
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = now;
  }

  function check(key: string) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, lastRefillMs: now };
      buckets.set(key, bucket);
    }

    refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    throw makeRateLimitError();
  }

  return { check };
}

export function getClientIp(req: http.IncomingMessage, trustProxyHeaders = false): string | undefined {
  if (trustProxyHeaders) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0]?.trim();
    }
  }

  const remote = (req.socket as any)?.remoteAddress;
  return typeof remote === 'string' ? remote : undefined;
}

