import type {
  ObservabilityCompatContext,
  ObservabilityProviderManifest
} from '../../../../kernel/index.js';
import { substituteEnv } from '../../../../kernel/index.js';
import type { CachedRequestSummary } from '../../../../modules/shared/index.js';
export {
  resolveMaxAttributeBytes,
  eventTimestampToIso,
  deriveStartTimeIsoFromDuration,
  getStringArrayMetadata,
  resolveTraceContext,
  getEventIds,
  getEnvelopeId,
  isRequestEvent,
  isResponseEvent,
  deriveStartTimeIso,
  cacheKey,
  buildInputJson,
  buildOutputJson,
  buildCachedRequestSummary,
  applyTraceUpdateToCachedRequests
} from '../../../../modules/shared/index.js';

const ALLOW_BASEURL_OVERRIDE_ENV = 'LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE';
const BASEURL_OVERRIDE_ALLOWLIST_ENV = 'LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST';

export function normalizeLangfuseObservationLevel(level: unknown): 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR' {
  const raw = typeof level === 'string' ? level.trim().toLowerCase() : '';
  if (raw === 'debug') return 'DEBUG';
  if (raw === 'warning' || raw === 'warn') return 'WARNING';
  if (raw === 'error') return 'ERROR';
  return 'DEFAULT';
}

export function buildCommonTraceAttributes(options: {
  traceId: string;
  sessionId?: string;
  traceName?: string;
  tags?: string[];
  batchId?: string;
}): Record<string, unknown> {
  const { traceId, sessionId, traceName, tags, batchId } = options;
  return {
    'llm.adapter.trace_id': String(traceId || ''),
    ...(sessionId ? { 'langfuse.session.id': sessionId, 'llm.adapter.session_id': sessionId } : {}),
    ...(traceName ? { 'langfuse.trace.name': traceName, 'llm.adapter.correlation_id': traceName } : {}),
    ...(tags ? { 'langfuse.trace.tags': tags } : {}),
    ...(batchId ? { 'llm.adapter.batch_id': batchId } : {})
  };
}

function readUsageNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}

export function buildLangfuseUsageDetails(usage: unknown): Record<string, number> {
  if (!usage || typeof usage !== 'object') return {};
  const u = usage as any;

  const input =
    readUsageNumber(u.input) ??
    readUsageNumber(u.input_tokens) ??
    readUsageNumber(u.promptTokens) ??
    readUsageNumber(u.prompt_tokens);
  const output =
    readUsageNumber(u.output) ??
    readUsageNumber(u.output_tokens) ??
    readUsageNumber(u.completionTokens) ??
    readUsageNumber(u.completion_tokens);
  const total =
    readUsageNumber(u.total) ??
    readUsageNumber(u.total_tokens) ??
    readUsageNumber(u.totalTokens);

  const cached =
    readUsageNumber(u.cached_tokens) ??
    readUsageNumber(u.cachedTokens);
  const reasoning =
    readUsageNumber(u.reasoning_tokens) ??
    readUsageNumber(u.reasoningTokens);
  const audio =
    readUsageNumber(u.audio_tokens) ??
    readUsageNumber(u.audioTokens);

  const details: Record<string, number> = {};
  if (input !== undefined) details.input = input;
  if (output !== undefined) details.output = output;
  if (total !== undefined) {
    details.total = total;
  } else if (input !== undefined || output !== undefined) {
    details.total = (input ?? 0) + (output ?? 0);
  }

  if (cached !== undefined) details.cached_tokens = cached;
  if (reasoning !== undefined) details.reasoning_tokens = reasoning;
  if (audio !== undefined) details.audio_tokens = audio;

  return details;
}

export function buildLangfuseCostDetails(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as any;

  const cost = readUsageNumber(u.cost);
  if (cost === undefined) return undefined;

  const details: Record<string, number> = { total: cost };

  const rawBreakdown = u.cost_details ?? u.costDetails;
  if (!rawBreakdown || typeof rawBreakdown !== 'object' || Array.isArray(rawBreakdown)) {
    return details;
  }

  for (const [key, value] of Object.entries(rawBreakdown as Record<string, unknown>)) {
    if (key === 'total') continue;
    const num = readUsageNumber(value);
    if (num !== undefined) details[key] = num;
  }

  return details;
}

function buildUrl(urlTemplate: string): string {
  const normalized = String(urlTemplate).replace(/\$\{([A-Z0-9_]+)\}/g, '${$1?}');
  return String(substituteEnv(normalized));
}

function isBaseUrlOverrideEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLM_LIVE === '1' || env[ALLOW_BASEURL_OVERRIDE_ENV] === '1';
}

function getBaseUrlOverrideAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  if (env.LLM_LIVE === '1') return null;

  const raw = String(env[BASEURL_OVERRIDE_ALLOWLIST_ENV] || '').trim();
  if (!raw) return null;

  const entries = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  return entries.length > 0 ? new Set(entries) : null;
}

function isUrlHostAllowlisted(url: URL, allowlist: Set<string> | null): boolean {
  if (!allowlist) return true;
  return allowlist.has(url.host.toLowerCase()) || allowlist.has(url.hostname.toLowerCase());
}

export function resolveIngestionUrl(
  manifest: ObservabilityProviderManifest,
  context?: ObservabilityCompatContext
): string {
  const resolved = buildUrl(manifest.endpoint.urlTemplate);

  const baseUrl = String((context?.providerConfig as any)?.baseUrl || '').trim();
  if (!baseUrl) return resolved;
  if (!isBaseUrlOverrideEnabled()) return resolved;

  let overrideUrl: URL;
  try {
    overrideUrl = new URL(baseUrl);
  } catch {
    return resolved;
  }

  if (overrideUrl.username || overrideUrl.password) return resolved;
  if (overrideUrl.protocol !== 'http:' && overrideUrl.protocol !== 'https:') return resolved;

  const allowlist = getBaseUrlOverrideAllowlist();
  if (process.env.LLM_LIVE !== '1' && !allowlist) return resolved;
  if (!isUrlHostAllowlisted(overrideUrl, allowlist)) return resolved;

  let pathnameAndSearch = '';
  try {
    const parsed = new URL(resolved);
    pathnameAndSearch = `${parsed.pathname}${parsed.search}`;
  } catch {
    pathnameAndSearch = resolved.startsWith('/') ? resolved : `/${resolved}`;
  }

  const overridePathnameAndSearch = `${overrideUrl.pathname}${overrideUrl.search}`;
  if (overridePathnameAndSearch !== '/' && overridePathnameAndSearch !== '') {
    if (overridePathnameAndSearch !== pathnameAndSearch) return resolved;
  }

  return `${overrideUrl.origin}${pathnameAndSearch}`;
}

export function buildBasicAuthHeader(manifest: ObservabilityProviderManifest): string {
  const cfg = manifest.auth;
  if (!cfg || cfg.type !== 'basic') {
    throw new Error('Langfuse compat requires basic auth configuration');
  }

  if (!cfg.publicKeyEnv || !cfg.secretKeyEnv) {
    throw new Error('Langfuse basic auth requires publicKeyEnv and secretKeyEnv');
  }

  const publicKey = String(process.env[cfg.publicKeyEnv] || '').trim();
  const secretKey = String(process.env[cfg.secretKeyEnv] || '').trim();
  if (!publicKey || !secretKey) {
    const missing = [
      !publicKey ? cfg.publicKeyEnv : null,
      !secretKey ? cfg.secretKeyEnv : null
    ].filter(Boolean);
    throw new Error(`Missing required env var(s) for Langfuse auth: ${missing.join(', ')}`);
  }

  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

export type CachedRequest = {
  summary: CachedRequestSummary;
  createdAtMs: number;
};
