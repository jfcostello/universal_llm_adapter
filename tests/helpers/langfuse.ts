import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

const GLOBAL_LOCK_DIR = path.join(os.tmpdir(), 'universal-llm-adapter-langfuse-read-lock');
const GLOBAL_LOCK_TTL_MS = 5 * 60_000;
const GLOBAL_MAX_CONCURRENT_READS = 1;
const GLOBAL_COOLDOWN_FILE = path.join(GLOBAL_LOCK_DIR, 'cooldown.json');

function readGlobalCooldownUntil(): number | null {
  try {
    if (!fs.existsSync(GLOBAL_COOLDOWN_FILE)) return null;
    const raw = fs.readFileSync(GLOBAL_COOLDOWN_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const until = typeof parsed?.until === 'number' ? parsed.until : null;
    if (!until) return null;
    if (Date.now() >= until) {
      try {
        fs.unlinkSync(GLOBAL_COOLDOWN_FILE);
      } catch {
        // best-effort
      }
      return null;
    }
    return until;
  } catch {
    return null;
  }
}

function writeGlobalCooldownFor(ms: number): void {
  const durationMs = Math.max(0, Math.floor(ms));
  if (durationMs <= 0) return;
  const proposedUntil = Date.now() + durationMs;
  try {
    fs.mkdirSync(GLOBAL_LOCK_DIR, { recursive: true });
    const existingUntil = readGlobalCooldownUntil();
    const until = existingUntil !== null ? Math.max(existingUntil, proposedUntil) : proposedUntil;
    fs.writeFileSync(GLOBAL_COOLDOWN_FILE, JSON.stringify({ until }), { flag: 'w' });
  } catch {
    // best-effort
  }
}

async function acquireGlobalReadSlot(): Promise<() => void> {
  fs.mkdirSync(GLOBAL_LOCK_DIR, { recursive: true });

  const slots = Array.from({ length: GLOBAL_MAX_CONCURRENT_READS }, (_, i) =>
    path.join(GLOBAL_LOCK_DIR, `slot-${i}.lock`)
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cooldownUntil = readGlobalCooldownUntil();
    if (cooldownUntil !== null) {
      const waitMs = Math.max(0, cooldownUntil - Date.now());
      const jitter = Math.floor(Math.random() * 250);
      await sleep(waitMs + jitter);
      continue;
    }

    for (const slotPath of slots) {
      try {
        fs.writeFileSync(
          slotPath,
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          { flag: 'wx' }
        );
        return () => {
          try {
            fs.unlinkSync(slotPath);
          } catch {
            // best-effort
          }
        };
      } catch (error: any) {
        // Slot is taken; consider cleaning up stale locks.
        if (error?.code !== 'EEXIST') continue;
        try {
          const raw = fs.readFileSync(slotPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const pid = typeof parsed?.pid === 'number' ? parsed.pid : null;
          const createdAt = typeof parsed?.createdAt === 'number' ? parsed.createdAt : null;
          const ageMs = createdAt ? Date.now() - createdAt : null;

          let pidAlive = false;
          if (pid !== null) {
            try {
              process.kill(pid, 0);
              pidAlive = true;
            } catch {
              pidAlive = false;
            }
          }

          const stale = (!pidAlive) || (ageMs !== null && ageMs > GLOBAL_LOCK_TTL_MS);
          if (stale) {
            fs.unlinkSync(slotPath);
          }
        } catch {
          // Ignore read/parse failures; we'll just wait below.
        }
      }
    }

    // No slots available; jitter to avoid lock-step polling across workers.
    const jitter = Math.floor(Math.random() * 100);
    await sleep(250 + jitter);
  }
}

async function fetchWithGlobalReadSlot(input: string, init: RequestInit): Promise<Response> {
  const release = await acquireGlobalReadSlot();
  try {
    return await fetch(input, init);
  } finally {
    release();
  }
}

// Keep this low to avoid hammering Langfuse during high-worker live runs.
const DEFAULT_CONCURRENCY = 1;
let active = 0;
const waiters: Array<() => void> = [];

async function withConcurrencyLimit<T>(
  fn: () => Promise<T>,
  limit: number = DEFAULT_CONCURRENCY
): Promise<T> {
  if (active >= limit) {
    await new Promise<void>(resolve => waiters.push(resolve));
  }

  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

export function getLangfuseBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.LANGFUSE_HOST || '').trim();
  if (!raw) return 'https://cloud.langfuse.com';

  try {
    const parsed = new URL(raw);
    return stripTrailingSlashes(parsed.origin);
  } catch {
    return 'https://cloud.langfuse.com';
  }
}

export function buildLangfuseAuthHeader(env: NodeJS.ProcessEnv = process.env): string {
  const publicKey = String(env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = String(env.LANGFUSE_SECRET_KEY || '').trim();
  if (!publicKey || !secretKey) {
    const missing = [
      !publicKey ? 'LANGFUSE_PUBLIC_KEY' : null,
      !secretKey ? 'LANGFUSE_SECRET_KEY' : null
    ].filter(Boolean);
    throw new Error(`Missing required env var(s) for Langfuse auth: ${missing.join(', ')}`);
  }

  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

export function createTraceId(prefix: string = 'live'): string {
  return `${prefix}-${randomUUID()}`;
}

export function toolNameVariants(name: string): string[] {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const variants = new Set<string>([raw]);
  variants.add(raw.replaceAll('.', '_'));
  variants.add(raw.replaceAll('.', '-'));
  return [...variants].filter(Boolean);
}

export function attachLangfuseObservability<T extends Record<string, any>>(
  spec: T,
  traceId: string
): T {
  const next: any = { ...(spec ?? {}) };
  next.metadata = {
    ...(next.metadata ?? {}),
    correlationId: traceId
  };
  next.observability = {
    ...(next.observability ?? {}),
    enabled: true,
    provider: 'langfuse',
    traceId,
    flushAt: 2
  };
  return next as T;
}

export async function waitForLangfuseTrace(
  traceId: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    baseUrl?: string;
    timeoutMs?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    concurrency?: number;
  } = {}
): Promise<any> {
  const env = opts.env ?? process.env;
  const baseUrl = stripTrailingSlashes(opts.baseUrl ?? getLangfuseBaseUrl(env));
  const authorization = buildLangfuseAuthHeader(env);
  const timeoutMs = Math.max(100, Math.floor(opts.timeoutMs ?? 30_000));
  const minDelayMs = Math.max(1, Math.floor(opts.minDelayMs ?? 500));
  const maxDelayMs = Math.max(minDelayMs, Math.floor(opts.maxDelayMs ?? 10_000));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));

  const url = `${baseUrl}/api/public/traces/${encodeURIComponent(String(traceId))}`;
  const start = Date.now();

  let delay = minDelayMs;
  let lastStatus: number | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) {
      const suffix = lastStatus ? ` (last status: ${lastStatus})` : '';
      throw new Error(`Timed out waiting for Langfuse trace: ${traceId}${suffix}`);
    }

    let res: any;
    try {
      res = await withConcurrencyLimit(
        () =>
          fetchWithGlobalReadSlot(url, {
            method: 'GET',
            headers: {
              Authorization: authorization,
              Accept: 'application/json'
            }
          }),
        concurrency
      );
    } catch {
      // Treat transient fetch errors as retryable.
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay / 2)));
      await sleep(delay + jitter);
      delay = Math.min(maxDelayMs, Math.floor(delay * 1.5) + 1);
      continue;
    }

    if (res.ok) {
      return await res.json();
    }

    lastStatus = typeof res.status === 'number' ? res.status : null;

    // Retryable statuses:
    // - 404: eventual consistency; trace not yet readable
    // - 429: Langfuse API rate limiting
    // - 5xx: transient server errors
    const status = Number(res.status);
    const retryable = status === 404 || status === 429 || (status >= 500 && status < 600);
    if (!retryable) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Langfuse trace fetch failed (${res.status}) for ${traceId}: ${text.slice(0, 500)}`
      );
    }

    // Respect Retry-After when rate limited.
    if (status === 429) {
      const retryAfterHeader = res.headers?.get?.('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        delay = Math.max(delay, Math.ceil(retryAfterSeconds * 1000));
        writeGlobalCooldownFor(Math.ceil(retryAfterSeconds * 1000));
      } else {
        // No Retry-After header; apply a conservative global backoff.
        writeGlobalCooldownFor(20_000);
      }
    }

    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay / 2)));
    await sleep(delay + jitter);
    delay = Math.min(maxDelayMs, Math.floor(delay * 1.5) + 1);
  }
}

export function stringifyLangfuseTrace(trace: unknown): string {
  try {
    return JSON.stringify(trace);
  } catch {
    return String(trace);
  }
}
