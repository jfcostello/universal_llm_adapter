import type http from 'http';
import { LruMap } from '../../../../kernel/index.js';

export interface RateLimitConfig {
  enabled: boolean;
  requestsPerMinute: number;
  burst: number;
  trustProxyHeaders?: boolean;
  /**
   * Maximum number of distinct keys to track in memory.
   * When exceeded, least-recently-used buckets are evicted.
   */
  maxKeys?: number;
  /**
   * Optional TTL (ms) after which an idle key's bucket is reset.
   * This avoids keeping long-lived buckets around for sporadic keys.
   */
  keyTtlMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
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

  const maxKeys = Math.max(1, Number.isFinite(Number(config.maxKeys)) ? Number(config.maxKeys) : 10000);
  const keyTtlMs = Math.max(0, Number(config.keyTtlMs ?? 0));

  const buckets = new LruMap<string, Bucket>(maxKeys);

  function refill(bucket: Bucket, now: number) {
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = now;
  }

  function check(key: string) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, lastRefillMs: now, lastSeenMs: now };
      buckets.set(key, bucket);
    }

    if (keyTtlMs > 0 && now - bucket.lastSeenMs > keyTtlMs) {
      bucket.tokens = burst;
      bucket.lastRefillMs = now;
    }

    refill(bucket, now);
    bucket.lastSeenMs = now;

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
    const value =
      typeof forwarded === 'string'
        ? forwarded
        : Array.isArray(forwarded)
          ? forwarded[0]
          : undefined;
    if (typeof value === 'string' && value.trim()) {
      return value.split(',')[0]?.trim();
    }
  }

  const remote = (req.socket as any)?.remoteAddress;
  return typeof remote === 'string' ? remote : undefined;
}
