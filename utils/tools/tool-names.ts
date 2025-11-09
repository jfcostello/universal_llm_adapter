export function sanitizeToolName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  sanitized = sanitized || 'tool';

  if (sanitized.length > 64) {
    sanitized = sanitized.substring(0, 64);
  }

  return sanitized;
}

