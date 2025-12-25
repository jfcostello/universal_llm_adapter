import { createHash } from 'crypto';

function isAllZeroHex(hex: string): boolean {
  const normalized = String(hex).trim().toLowerCase();
  return /^0+$/.test(normalized);
}

function normalizeHex(hex: string): string {
  return String(hex).trim().toLowerCase();
}

function sha256Hex(input: string, bytes: number): string {
  const digest = createHash('sha256').update(String(input)).digest();
  const slice = Buffer.from(digest.subarray(0, bytes));
  let hex = slice.toString('hex');

  // OTLP IDs MUST NOT be all-zero. This should be cryptographically impossible
  // in practice, but enforce anyway for correctness.
  if (isAllZeroHex(hex)) {
    const patched = Buffer.from(slice);
    patched[patched.length - 1] = 1;
    hex = patched.toString('hex');
  }

  return hex;
}

export function deriveOtlpTraceIdHex(traceId: string): string {
  const normalized = normalizeHex(traceId);
  if (/^[0-9a-f]{32}$/.test(normalized) && !isAllZeroHex(normalized)) {
    return normalized;
  }
  return sha256Hex(traceId, 16);
}

export function deriveOtlpSpanIdHex(spanId: string): string {
  const normalized = normalizeHex(spanId);
  if (/^[0-9a-f]{16}$/.test(normalized) && !isAllZeroHex(normalized)) {
    return normalized;
  }
  return sha256Hex(spanId, 8);
}
