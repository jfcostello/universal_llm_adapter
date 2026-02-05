import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

function getSentryBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.SENTRY_BASE_URL || '').trim();
  if (!raw) return 'https://sentry.io';

  try {
    const parsed = new URL(raw);
    return stripTrailingSlashes(parsed.origin);
  } catch {
    return 'https://sentry.io';
  }
}

function buildSentryAuthHeader(env: NodeJS.ProcessEnv = process.env): string {
  const token = String(env.SENTRY_API_KEY || '').trim();
  if (!token) {
    throw new Error('Missing required env var for Sentry API auth: SENTRY_API_KEY');
  }
  return `Bearer ${token}`;
}

function getSentryOrgSlug(env: NodeJS.ProcessEnv = process.env): string {
  const org = String(env.SENTRY_ORG_SLUG || '').trim();
  if (!org) {
    throw new Error('Missing required env var for Sentry API access: SENTRY_ORG_SLUG');
  }
  return org;
}

function getSentryProjectSlug(env: NodeJS.ProcessEnv = process.env): string {
  const project = String(env.SENTRY_PROJECT_SLUG || '').trim();
  if (!project) {
    throw new Error('Missing required env var for Sentry API access: SENTRY_PROJECT_SLUG');
  }
  return project;
}

function readPositiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = String(env[key] ?? '').trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

const GLOBAL_LOCK_DIR = path.join(os.tmpdir(), 'universal-llm-adapter-sentry-read-lock');
const GLOBAL_LOCK_TTL_MS = 90_000;
const DEFAULT_SENTRY_429_COOLDOWN_MS = 60_000;
const GLOBAL_MAX_CONCURRENT_READS = (() => {
  const raw = process.env.LLM_LIVE_SENTRY_MAX_CONCURRENT_READS;
  const parsed = raw ? Number.parseInt(String(raw), 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
})();
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
      } catch {}
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
  } catch {}
}

async function acquireGlobalReadSlot(options: { timeoutMs?: number } = {}): Promise<() => void> {
  fs.mkdirSync(GLOBAL_LOCK_DIR, { recursive: true });
  const timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? 30_000));
  const deadlineMs = Date.now() + timeoutMs;

  const slots = Array.from({ length: GLOBAL_MAX_CONCURRENT_READS }, (_, i) =>
    path.join(GLOBAL_LOCK_DIR, `slot-${i}.lock`)
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() >= deadlineMs) {
      throw new Error(`Timed out waiting for global Sentry read slot (timeout ${timeoutMs}ms)`);
    }

    const cooldownUntil = readGlobalCooldownUntil();
    if (cooldownUntil !== null) {
      const waitMs = Math.max(0, cooldownUntil - Date.now());
      const jitter = Math.floor(Math.random() * 250);
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      await sleep(Math.min(waitMs + jitter, remainingMs));
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
          } catch {}
        };
      } catch (error: any) {
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
        } catch {}
      }
    }

    const jitter = Math.floor(Math.random() * 100);
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    await sleep(Math.min(250 + jitter, remainingMs));
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithGlobalReadSlot(
  input: string,
  init: RequestInit,
  options: { slotTimeoutMs: number; fetchTimeoutMs: number }
): Promise<Response> {
  const release = await acquireGlobalReadSlot({ timeoutMs: options.slotTimeoutMs });
  try {
    return await fetchWithTimeout(input, init, options.fetchTimeoutMs);
  } finally {
    release();
  }
}

function normalizeStatsPeriod(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '1h';
  return raw;
}

export function attachSentryObservability<T extends Record<string, any>>(
  spec: T,
  traceId: string,
  options: { sessionId?: string; enableOtlp?: boolean; providerConfig?: Record<string, unknown> } = {}
): T {
  const next: any = { ...(spec ?? {}) };
  const providerConfig: Record<string, unknown> =
    options.providerConfig && typeof options.providerConfig === 'object' && !Array.isArray(options.providerConfig)
      ? { ...(options.providerConfig as Record<string, unknown>) }
      : {};

  if (options.enableOtlp !== false) {
    providerConfig.enableOtlp = true;
  }

  next.observability = {
    ...(next.observability ?? {}),
    enabled: true,
    traceId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    flushAt: 2,
    captureMessages: 'text',
    targets: [
      {
        provider: 'sentry',
        ...(Object.keys(providerConfig).length > 0 ? { providerConfig } : {}),
        export: { traces: true, tools: true, signals: true, traceUpdates: true }
      }
    ]
  };
  return next as T;
}

function getSentryFetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveIntEnv(env, 'LLM_LIVE_SENTRY_FETCH_TIMEOUT_MS') ?? 20_000;
}

export type SentryDiscoverRow = {
  id?: string;
  project?: string;
  trace?: string;
  timestamp?: string;
  title?: string;
  [key: string]: any;
};

export async function querySentryDiscover(options: {
  query: string;
  fields: string[];
  statsPeriod?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ status: number; rows: SentryDiscoverRow[]; raw: any; retryAfterMs?: number }> {
  const env = options.env ?? process.env;
  const baseUrl = getSentryBaseUrl(env);
  const orgSlug = getSentryOrgSlug(env);
  const authorization = buildSentryAuthHeader(env);

  const url = new URL(`${baseUrl}/api/0/organizations/${encodeURIComponent(orgSlug)}/events/`);
  url.searchParams.set('query', String(options.query || '').trim());
  url.searchParams.set('statsPeriod', normalizeStatsPeriod(options.statsPeriod));
  for (const field of options.fields) {
    const trimmed = String(field || '').trim();
    if (trimmed) url.searchParams.append('field', trimmed);
  }

  const fetchTimeoutMs = getSentryFetchTimeoutMs(env);
  const res = await fetchWithGlobalReadSlot(String(url), {
    method: 'GET',
    headers: { Authorization: authorization }
  }, { slotTimeoutMs: 30_000, fetchTimeoutMs });

  const retryAfter = res.headers.get('retry-after');
  const retryAfterSeconds = retryAfter ? Number.parseFloat(retryAfter) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(0, Math.floor(retryAfterSeconds * 1000))
    : undefined;

  const text = await res.text();
  const raw = text ? JSON.parse(text) : null;
  const rows = Array.isArray(raw?.data) ? raw.data : [];

  return { status: res.status, rows, raw, retryAfterMs };
}

export async function getSentryEvent(options: {
  eventId: string;
  projectSlug?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<any> {
  const env = options.env ?? process.env;
  const baseUrl = getSentryBaseUrl(env);
  const orgSlug = getSentryOrgSlug(env);
  const projectSlug = options.projectSlug ?? getSentryProjectSlug(env);
  const authorization = buildSentryAuthHeader(env);

  const url = `${baseUrl}/api/0/projects/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}/events/${encodeURIComponent(options.eventId)}/`;
  const fetchTimeoutMs = getSentryFetchTimeoutMs(env);
  const res = await fetchWithGlobalReadSlot(url, {
    method: 'GET',
    headers: { Authorization: authorization }
  }, { slotTimeoutMs: 30_000, fetchTimeoutMs });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch Sentry event ${options.eventId} (${projectSlug}): HTTP ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export function extractSentryTraceId(event: any): string | null {
  const traceId = event?.contexts?.trace?.trace_id;
  if (typeof traceId !== 'string') return null;
  const trimmed = traceId.trim();
  return trimmed ? trimmed : null;
}

export function stableHashSuffix(input: string): string {
  const raw = String(input || '');
  return createHash('sha256').update(raw).digest('hex').slice(0, 10);
}

export async function waitForSentryEventDetail(options: {
  query: string;
  fields?: string[];
  statsPeriod?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  match?: (event: any) => boolean;
}): Promise<any> {
  const env = options.env ?? process.env;
  const fields = (options.fields?.length ? options.fields : ['id', 'project', 'trace', 'timestamp', 'title']) as string[];

  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? (env.LLM_LIVE === '1' ? 300_000 : 90_000)));
  const minDelayMs = Math.max(250, Math.floor(options.minDelayMs ?? 2000));
  const maxDelayMs = Math.max(minDelayMs, Math.floor(options.maxDelayMs ?? 60_000));
  const start = Date.now();

  let delay = minDelayMs;
  let polls = 0;
  let lastStatus: number | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) {
      const suffix = lastStatus ? ` (last status: ${lastStatus})` : '';
      throw new Error(`Timed out waiting for Sentry event for query: ${options.query}${suffix}`);
    }

    polls++;

    const res = await querySentryDiscover({
      env,
      query: options.query,
      fields,
      statsPeriod: options.statsPeriod
    });
    lastStatus = res.status;

    if (res.status === 429) {
      writeGlobalCooldownFor(res.retryAfterMs ?? DEFAULT_SENTRY_429_COOLDOWN_MS);
    }

    if (res.status >= 200 && res.status < 300 && res.rows.length > 0) {
      for (const row of res.rows) {
        const eventId = typeof row?.id === 'string' ? String(row.id).trim() : '';
        if (!eventId) continue;
        const projectSlug = typeof row?.project === 'string' && row.project.trim() !== ''
          ? row.project.trim()
          : undefined;

        const event = await getSentryEvent({ env, eventId, projectSlug });
        if (!options.match || options.match(event)) {
          return event;
        }
      }
    }

    const jitter = Math.floor(Math.random() * 250);
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    await sleep(Math.min(delay + jitter, remainingMs));
    delay = Math.min(maxDelayMs, Math.floor(delay * 1.5));
  }
}
