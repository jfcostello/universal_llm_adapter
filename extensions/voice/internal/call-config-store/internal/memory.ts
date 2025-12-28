import type { VoiceCallConfigStore, VoiceCallConfigV1 } from '../index.js';

function assertNonEmpty(label: string, value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return raw;
}

function assertTtlSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('ttlSeconds must be a positive number');
  }
  return n;
}

function computeExpiryMs(ttlSeconds: number): number {
  const ttlMs = Math.floor(ttlSeconds * 1000);
  return Date.now() + Math.max(0, ttlMs);
}

export function createInMemoryVoiceCallConfigStore(): VoiceCallConfigStore {
  const configs = new Map<string, VoiceCallConfigV1>();
  const idempotency = new Map<string, { value: any; expiresAtMs: number }>();
  const nonces = new Map<string, number>();

  const getIfNotExpired = <T>(map: Map<string, { value: T; expiresAtMs: number }>, key: string): T | null => {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      map.delete(key);
      return null;
    }
    return entry.value;
  };

  return {
    putConfig: async (config: VoiceCallConfigV1, options: { ttlSeconds: number }) => {
      const callConfigId = assertNonEmpty('callConfigId', (config as any)?.callConfigId);
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);

      const now = Date.now();
      const createdAtMs = Number.isFinite((config as any)?.createdAtMs) && (config as any).createdAtMs > 0
        ? (config as any).createdAtMs
        : now;
      const expiresAtMs = computeExpiryMs(ttlSeconds);

      configs.set(callConfigId, { ...(config as any), callConfigId, createdAtMs, expiresAtMs });
    },

    getConfig: async (callConfigId: string) => {
      const id = assertNonEmpty('callConfigId', callConfigId);
      const cfg = configs.get(id);
      if (!cfg) return null;
      if (Date.now() > cfg.expiresAtMs) {
        configs.delete(id);
        return null;
      }
      return cfg;
    },

    deleteConfig: async (callConfigId: string) => {
      const id = assertNonEmpty('callConfigId', callConfigId);
      configs.delete(id);
    },

    putIdempotency: async (key: string, value: any, options: { ttlSeconds: number }) => {
      const safeKey = assertNonEmpty('idempotency key', key);
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);
      idempotency.set(safeKey, { value, expiresAtMs: computeExpiryMs(ttlSeconds) });
    },

    getIdempotency: async (key: string) => {
      const safeKey = assertNonEmpty('idempotency key', key);
      return getIfNotExpired(idempotency, safeKey);
    },

    consumeNonceOnce: async (nonce: string, options: { ttlSeconds: number }) => {
      const safeNonce = assertNonEmpty('nonce', nonce);
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);

      const now = Date.now();
      const expiresAtMs = nonces.get(safeNonce);
      if (typeof expiresAtMs === 'number' && now <= expiresAtMs) {
        return false;
      }
      nonces.set(safeNonce, computeExpiryMs(ttlSeconds));
      return true;
    }
  };
}

