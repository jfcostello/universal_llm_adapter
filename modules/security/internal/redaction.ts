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
