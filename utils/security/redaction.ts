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
