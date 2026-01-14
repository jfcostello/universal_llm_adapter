export type ValidateE164Result =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates and normalizes a phone number to E.164 format.
 * E.164 format: + followed by 1-15 digits, starting with a non-zero digit.
 * Examples: +14155551234, +442071234567
 */
export function validateE164(value: unknown): ValidateE164Result {
  const trimmed = String(value ?? '').trim();

  if (!trimmed) {
    return { ok: false, error: 'Phone number is required' };
  }

  // E.164: + followed by 1-15 digits, first digit must be non-zero (country code)
  // Minimum 2 digits ensures at least country code + 1 subscriber digit
  if (!/^\+[1-9]\d{1,14}$/.test(trimmed)) {
    return { ok: false, error: 'Invalid E.164 phone number format (expected +[country code][number], e.g. +14155551234)' };
  }

  return { ok: true, value: trimmed };
}
