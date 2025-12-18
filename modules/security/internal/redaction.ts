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
const DEFAULT_SENSITIVE_PARAMS = [
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
 * Shows only the last 4 characters of sensitive values (e.g., `key=***1234`).
 *
 * @param url - The URL string to redact
 * @param sensitiveParams - Optional list of parameter names to redact (case-insensitive).
 *                         Defaults to common credential parameter names.
 * @returns The URL with sensitive query parameters redacted, or the original string if parsing fails.
 */
export function redactUrlQueryParams(url: string, sensitiveParams?: string[]): string {
  const paramsToRedact = sensitiveParams ?? DEFAULT_SENSITIVE_PARAMS;
  const paramsLower = new Set(paramsToRedact.map(p => p.toLowerCase()));

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a valid URL, return as-is
    return url;
  }

  // If no query params, return URL as-is (preserves original format)
  if (parsed.searchParams.size === 0) {
    return url;
  }

  // Redact sensitive params
  for (const [key] of parsed.searchParams) {
    if (paramsLower.has(key.toLowerCase())) {
      const value = parsed.searchParams.get(key) ?? '';
      if (value.length === 0) {
        // Empty value stays empty
        continue;
      }
      const redacted = value.length <= 4 ? '***' : `***${value.slice(-4)}`;
      parsed.searchParams.set(key, redacted);
    }
  }

  return parsed.toString();
}

/**
 * Redacts both basic-auth credentials and sensitive query parameters in a URL.
 * Combines `redactUrlCredentials` and `redactUrlQueryParams`.
 *
 * @param url - The URL string to redact
 * @returns The URL with both basic-auth and query parameter credentials redacted.
 */
export function redactUrl(url: string): string {
  return redactUrlQueryParams(redactUrlCredentials(url));
}
