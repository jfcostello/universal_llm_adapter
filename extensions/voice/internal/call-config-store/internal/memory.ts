import type { VoiceCallConfigStore, VoiceCallConfigV1 } from '../index.js';
import { assertNonEmpty, assertTtlSeconds, computeExpiryMs, normalizeConfigForPut } from './shared.js';

export function createInMemoryVoiceCallConfigStore(options?: { sweepEveryOps?: number; sweepIntervalMs?: number }): VoiceCallConfigStore {
  const sweepEveryOps = (() => {
    const raw = options?.sweepEveryOps;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 250;
    return Math.max(1, Math.floor(raw));
  })();

  const sweepIntervalMs = (() => {
    const raw = options?.sweepIntervalMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    if (raw <= 0) return undefined;
    return Math.max(1, Math.floor(raw));
  })();

  const configs = new Map<string, VoiceCallConfigV1>();
  const idempotency = new Map<string, { value: any; expiresAtMs: number }>();
  const nonces = new Map<string, number>();

  let ops = 0;
  const sweepExpired = (now: number) => {
    for (const [key, cfg] of configs.entries()) {
      if (now > cfg.expiresAtMs) configs.delete(key);
    }
    for (const [key, entry] of idempotency.entries()) {
      if (now > entry.expiresAtMs) idempotency.delete(key);
    }
    for (const [key, expiresAtMs] of nonces.entries()) {
      if (now > expiresAtMs) nonces.delete(key);
    }
  };

  const maybeSweep = () => {
    ops++;
    if (ops % sweepEveryOps !== 0) return;
    sweepExpired(Date.now());
  };

  const sweepTimer = (() => {
    if (!sweepIntervalMs) return undefined;
    const timer = setInterval(() => {
      sweepExpired(Date.now());
    }, sweepIntervalMs);
    if (typeof (timer as any)?.unref === 'function') {
      (timer as any).unref();
    }
    return timer;
  })();

  const getIfNotExpired = <T>(map: Map<string, { value: T; expiresAtMs: number }>, key: string): T | null => {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      map.delete(key);
      return null;
    }
    return entry.value;
  };

  const store: VoiceCallConfigStore & { close?: () => Promise<void> } = {
    putConfig: async (config: VoiceCallConfigV1, options: { ttlSeconds: number }) => {
      maybeSweep();
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
      maybeSweep();
      const id = assertNonEmpty('callConfigId', callConfigId);
      configs.delete(id);
    },

    putIdempotency: async (key: string, value: any, options: { ttlSeconds: number }) => {
      maybeSweep();
      const safeKey = assertNonEmpty('idempotency key', key);
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);
      idempotency.set(safeKey, { value, expiresAtMs: computeExpiryMs(ttlSeconds) });
    },

    getIdempotency: async (key: string) => {
      const safeKey = assertNonEmpty('idempotency key', key);
      return getIfNotExpired(idempotency, safeKey);
    },

    consumeNonceOnce: async (nonce: string, options: { ttlSeconds: number }) => {
      maybeSweep();
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

  if (sweepTimer !== undefined) {
    store.close = async () => {
      clearInterval(sweepTimer);
    };
  }

  return store;
}
