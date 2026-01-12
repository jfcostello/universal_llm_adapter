import type { VoiceCallConfigV1 } from '../index.js';

export function assertNonEmpty(label: string, value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return raw;
}

export function assertTtlSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('ttlSeconds must be a positive number');
  }
  return n;
}

export function computeExpiryMs(ttlSeconds: number): number {
  const ttlMs = Math.floor(ttlSeconds * 1000);
  return Date.now() + Math.max(0, ttlMs);
}

export function normalizeConfigForPut(config: VoiceCallConfigV1, ttlSeconds: number): VoiceCallConfigV1 {
  const callConfigId = assertNonEmpty('callConfigId', (config as any)?.callConfigId);

  const now = Date.now();
  const createdAtMs = Number.isFinite((config as any)?.createdAtMs) && (config as any).createdAtMs > 0
    ? (config as any).createdAtMs
    : now;
  const expiresAtMs = computeExpiryMs(ttlSeconds);

  return { ...(config as any), callConfigId, createdAtMs, expiresAtMs };
}

export function encodeKeySegment(value: string): string {
  const raw = assertNonEmpty('key', value);
  const bytes = Buffer.from(raw, 'utf-8');
  // Node >=18 supports base64url.
  return bytes.toString('base64url');
}

