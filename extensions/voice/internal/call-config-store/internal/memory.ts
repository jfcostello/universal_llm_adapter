import type { VoiceCallConfigStore, VoiceCallConfigV1 } from '../index.js';
import { assertNonEmpty, assertTtlSeconds, computeExpiryMs, normalizeConfigForPut } from './shared.js';

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
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);
      const normalized = normalizeConfigForPut(config, ttlSeconds);
      configs.set(normalized.callConfigId, normalized);
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
