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
 * Default query parameter names that are considered sensitive and should be redacted.
 * Matching is case-insensitive.
 */
const DEFAULT_SENSITIVE_QUERY_PARAMS = [
  'key',
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'auth',
  'credential'
];

const DEFAULT_SENSITIVE_JSON_KEYS = [
  ...DEFAULT_SENSITIVE_QUERY_PARAMS,
  'authorization',
  'x-api-key',
  'x-goog-api-key'
];

function redactSensitiveString(value: string): string {
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (match && match[1]) {
    const token = match[1];
    const redacted = token.length <= 4 ? '***' : `***${token.slice(-4)}`;
    return `Bearer ${redacted}`;
  }

  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
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
  const paramsToRedact = sensitiveParams ?? DEFAULT_SENSITIVE_QUERY_PARAMS;
  const paramsLower = new Set(paramsToRedact.map(p => p.toLowerCase()));

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
    if (!paramsLower.has(key.toLowerCase())) continue;
    const value = parsed.searchParams.get(key) || '';
    if (!value) continue;
    const redacted = value.length <= 4 ? '***' : `***${value.slice(-4)}`;
    parsed.searchParams.set(key, redacted);
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
  const keys = sensitiveKeys ?? DEFAULT_SENSITIVE_JSON_KEYS;
  const keysLower = new Set(keys.map(k => k.toLowerCase()));
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
      if (keysLower.has(key.toLowerCase())) {
        if (typeof raw === 'string') {
          out[key] = redactSensitiveString(raw);
        } else if (raw === null || raw === undefined) {
          out[key] = raw;
        } else {
          out[key] = '***';
        }
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
