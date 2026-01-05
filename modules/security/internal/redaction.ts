import { getDefaults } from '../../../kernel/index.js';

export function genericRedactHeaders(headers: Record<string, any>): Record<string, any> {
  const redacted = { ...headers };

  const authHeader = redacted.Authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/Bearer (.+)/);
    if (match && match[1]) {
      const key = match[1];
      redacted.Authorization = `Bearer ***${key.slice(-4)}`;
    }
  }

  const apiKey = redacted['x-api-key'];
  if (typeof apiKey === 'string') {
    redacted['x-api-key'] = `***${apiKey.slice(-4)}`;
  }

  return redacted;
}

export function redactUrlCredentials(url: string): string {
  return url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
}

/**
 * Default key names that are considered sensitive and should be redacted.
 * Matching is case-insensitive, and supports glob-style `*` wildcards.
 */
const FALLBACK_SENSITIVE_KEYS = [
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api_key',
  'apikey',
  '*api_key*',
  '*api-key*',
  '*apikey*',
  'key',
  'secret',
  'password',
  'credential',
  'auth'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readSensitiveKeysFromDefaults(defaults: unknown): unknown {
  if (!isRecord(defaults)) return undefined;
  const security = defaults.security;
  if (!isRecord(security)) return undefined;
  const redaction = security.redaction;
  if (!isRecord(redaction)) return undefined;
  return redaction.sensitiveKeys;
}

function normalizeKeyPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .map((p) => String(p).trim())
    .filter(Boolean);
}

const SENSITIVE_KEY_MATCHER_CACHE_MAX = 50;
const sensitiveKeyMatcherCache = new Map<string, (key: string) => boolean>();

function normalizeMatcherPatterns(patterns: unknown): string[] {
  const normalized = normalizeKeyPatterns(patterns).map((pattern) => pattern.toLowerCase());
  return Array.from(new Set(normalized)).sort();
}

function buildMatcherCacheKey(patterns: string[]): string {
  return patterns.join('\u0000');
}

function resolveSensitiveKeyPatterns(overrides?: string[]): string[] {
  if (overrides !== undefined) return normalizeKeyPatterns(overrides);

  const defaults = getDefaults();
  const fromConfig = readSensitiveKeysFromDefaults(defaults);
  const normalized = normalizeKeyPatterns(fromConfig);
  return normalized.length > 0 ? normalized : FALLBACK_SENSITIVE_KEYS;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileGlobPattern(pattern: string): RegExp {
  const parts = pattern.split('*').map(escapeRegExp);
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

export function createSensitiveKeyMatcher(patterns: string[]): (key: string) => boolean {
  const normalized = normalizeMatcherPatterns(patterns);
  if (normalized.length === 0) return () => false;

  const cacheKey = buildMatcherCacheKey(normalized);
  const cached = sensitiveKeyMatcherCache.get(cacheKey);
  if (cached) return cached;

  const exact = new Set<string>();
  const regexes: RegExp[] = [];

  for (const raw of normalized) {
    if (raw.includes('*')) {
      regexes.push(compileGlobPattern(raw));
      continue;
    }
    exact.add(raw);
  }

  const matcher = (key: string): boolean => {
    const lower = String(key).toLowerCase();
    if (exact.has(lower)) return true;
    for (const re of regexes) {
      if (re.test(lower)) return true;
    }
    return false;
  };

  if (sensitiveKeyMatcherCache.size >= SENSITIVE_KEY_MATCHER_CACHE_MAX) {
    const oldest = sensitiveKeyMatcherCache.keys().next().value as string;
    sensitiveKeyMatcherCache.delete(oldest);
  }
  sensitiveKeyMatcherCache.set(cacheKey, matcher);

  return matcher;
}

export function getSensitiveKeyPatternsFromDefaults(): string[] {
  return resolveSensitiveKeyPatterns();
}

export function redactSensitiveString(value: string): string {
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (match && match[1]) {
    const token = match[1];
    const redacted = token.length <= 4 ? '***' : `***${token.slice(-4)}`;
    return `Bearer ${redacted}`;
  }

  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (value === null || value === undefined) return value;
  return '***';
}

function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

/**
 * Redacts sensitive query parameters in a URL string.
 * Shows only the last 4 characters of sensitive values (for example `key=***1234`).
 *
 * @param url - The URL string to redact.
 * @param sensitiveParams - Optional list of parameter names to redact (case-insensitive). Defaults to common credential names.
 * @returns The URL with sensitive query parameters redacted, or the original string if parsing fails.
 */
export function redactUrlQueryCredentials(url: string, sensitiveParams?: string[]): string {
  const paramsToRedact = resolveSensitiveKeyPatterns(sensitiveParams);
  const shouldRedactParam = createSensitiveKeyMatcher(paramsToRedact);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.searchParams.size === 0) {
    // Preserve exact formatting for URLs without a query string.
    return url;
  }

  for (const [key] of parsed.searchParams) {
    if (!shouldRedactParam(key)) continue;
    const value = parsed.searchParams.get(key) || '';
    if (!value) continue;
    parsed.searchParams.set(key, redactSensitiveString(value));
  }

  return parsed.toString();
}

/**
 * Alias for `redactUrlQueryCredentials` (kept for readability in some call sites).
 */
export function redactUrlQueryParams(url: string, sensitiveParams?: string[]): string {
  return redactUrlQueryCredentials(url, sensitiveParams);
}

/**
 * Redacts both basic-auth credentials and sensitive query parameters in a URL.
 */
export function redactUrl(url: string): string {
  return redactUrlQueryCredentials(redactUrlCredentials(url));
}

/**
 * Redacts credentials in JSON-like data structures (objects/arrays/primitives).
 *
 * - Redacts values for common credential key names (case-insensitive).
 * - Redacts URL credentials + sensitive query params inside URL-like strings.
 *
 * This is intentionally conservative: it only redacts by key-name/URL parsing and does not attempt
 * heuristic scanning of arbitrary text fields.
 */
export function redactJsonCredentials(value: unknown, sensitiveKeys?: string[]): unknown {
  const keys = resolveSensitiveKeyPatterns(sensitiveKeys);
  const shouldRedactKey = createSensitiveKeyMatcher(keys);
  const seen = new WeakMap<object, any>();
  const maxDepth = 25;

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[MaxDepth]';
    if (input === null || input === undefined) return input;

    const type = typeof input;
    if (type === 'string') {
      const str = String(input);
      return looksLikeUrl(str) ? redactUrl(str) : str;
    }

    if (type !== 'object') {
      return input;
    }

    if (input instanceof Date) {
      return input.toISOString();
    }

    if (input instanceof Error) {
      return { name: input.name, message: input.message };
    }

    if (Buffer.isBuffer(input)) {
      return { redacted: true, type: 'buffer', length: input.length };
    }

    if (Array.isArray(input)) {
      return input.map(item => walk(item, depth + 1));
    }

    const obj = input as Record<string, unknown>;
    const existing = seen.get(obj);
    if (existing) return existing;

    const out: Record<string, unknown> = {};
    seen.set(obj, out);

    for (const [key, raw] of Object.entries(obj)) {
      if (shouldRedactKey(key)) {
        out[key] = redactSensitiveValue(raw);
        continue;
      }

      out[key] = walk(raw, depth + 1);
    }

    return out;
  };

  try {
    return walk(value, 0);
  } catch {
    return value;
  }
}
