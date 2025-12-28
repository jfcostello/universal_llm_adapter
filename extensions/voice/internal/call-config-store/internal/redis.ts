import type { VoiceCallConfigStore, VoiceCallConfigV1 } from '../index.js';
import { assertNonEmpty, assertTtlSeconds, encodeKeySegment, normalizeConfigForPut } from './shared.js';

export interface RedisClientLike {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { EX?: number; NX?: boolean }) => Promise<any>;
  del: (key: string) => Promise<number>;

  /**
   * Optional Redis methods that are not required by the store itself, but may be
   * useful for operational debugging tools that share the same client instance.
   *
   * The store never calls these directly.
   */
  ttl?: (key: string) => Promise<number>;
  scan?: (...args: any[]) => Promise<any>;
  keys?: (pattern: string) => Promise<string[]>;
}

function jsonStringify(value: any): string {
  return JSON.stringify(value);
}

function jsonParse(text: string): any {
  return JSON.parse(text);
}

export function createRedisVoiceCallConfigStore(options: {
  client: RedisClientLike;
  prefix?: string;
}): VoiceCallConfigStore {
  const client = options.client;
  const prefix = String(options.prefix ?? 'llm_adapter:voice:v1:');

  const cfgKey = (callConfigId: string) => `${prefix}cfg:${callConfigId}`;
  const idempotencyKey = (key: string) => `${prefix}idem:${encodeKeySegment(key)}`;
  const nonceKey = (nonce: string) => `${prefix}nonce:${encodeKeySegment(nonce)}`;

  return {
    putConfig: async (config: VoiceCallConfigV1, options: { ttlSeconds: number }) => {
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);
      const normalized = normalizeConfigForPut(config, ttlSeconds);
      await client.set(cfgKey(normalized.callConfigId), jsonStringify(normalized), { EX: ttlSeconds });
    },

    getConfig: async (callConfigId: string) => {
      const id = assertNonEmpty('callConfigId', callConfigId);
      const raw = await client.get(cfgKey(id));
      if (!raw) return null;
      return jsonParse(raw) as VoiceCallConfigV1;
    },

    deleteConfig: async (callConfigId: string) => {
      const id = assertNonEmpty('callConfigId', callConfigId);
      await client.del(cfgKey(id));
    },

    putIdempotency: async (key: string, value: any, options: { ttlSeconds: number }) => {
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);
      const safeKey = assertNonEmpty('idempotency key', key);
      await client.set(idempotencyKey(safeKey), jsonStringify(value), { EX: ttlSeconds });
    },

    getIdempotency: async (key: string) => {
      const safeKey = assertNonEmpty('idempotency key', key);
      const raw = await client.get(idempotencyKey(safeKey));
      if (!raw) return null;
      return jsonParse(raw);
    },

    consumeNonceOnce: async (nonce: string, options: { ttlSeconds: number }) => {
      const ttlSeconds = assertTtlSeconds(options?.ttlSeconds);
      const safeNonce = assertNonEmpty('nonce', nonce);
      const result = await client.set(nonceKey(safeNonce), '1', { NX: true, EX: ttlSeconds });
      return result === 'OK';
    }
  };
}
