import { redactJsonCredentials } from '../../../../security/index.js';

export function redactUnsupportedExtraValue(field: string, value: any): unknown {
  if (value === undefined || value === null) return value;

  try {
    const wrapped: Record<string, unknown> = { [field]: value };
    const redacted = redactJsonCredentials(wrapped, [field]) as Record<string, unknown>;
    return redacted[field];
  } catch {
    return '***';
  }
}
