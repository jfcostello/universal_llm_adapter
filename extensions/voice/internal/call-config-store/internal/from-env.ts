import type { VoiceCallConfigStore } from '../index.js';

import { createInMemoryVoiceCallConfigStore } from './memory.js';
import { createRedisVoiceCallConfigStore } from './redis.js';

type StoreKind = 'memory' | 'redis';

function normalizeStoreKind(value: unknown): StoreKind {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'memory';
  if (raw === 'memory' || raw === 'in-memory' || raw === 'inmemory' || raw === 'mem') return 'memory';
  if (raw === 'redis') return 'redis';
  throw new Error('Invalid LLM_ADAPTER_VOICE_CALL_CONFIG_STORE');
}

function readTrimmedEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

async function loadRedisCreateClient(): Promise<(options: { url: string }) => any> {
  const mod: any = await import('redis');
  const createClient = mod?.createClient ?? mod?.default?.createClient;
  if (typeof createClient !== 'function') {
    throw new Error('Redis client library does not export createClient()');
  }
  return createClient;
}

export async function createVoiceCallConfigStoreFromEnv(): Promise<{
  store: VoiceCallConfigStore;
  close?: () => Promise<void>;
  kind: StoreKind;
}> {
  const kind = normalizeStoreKind(process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE);
  if (kind === 'memory') {
    return { kind, store: createInMemoryVoiceCallConfigStore() };
  }

  const url = readTrimmedEnv('LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL');
  if (!url) {
    throw new Error('Missing LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL');
  }

  const prefix = readTrimmedEnv('LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX');

  const createClient = await loadRedisCreateClient();
  const client = createClient({ url });

  if (typeof client?.on === 'function') {
    client.on('error', () => {});
  }

  if (typeof client?.connect === 'function') {
    await client.connect();
  } else {
    throw new Error('Redis client missing connect()');
  }

  const store = createRedisVoiceCallConfigStore({
    client,
    ...(prefix ? { prefix } : {})
  });

  return {
    kind,
    store,
    close: async () => {
      try {
        if (typeof client?.quit === 'function') {
          await client.quit();
          return;
        }
      } catch {}
      try {
        if (typeof client?.disconnect === 'function') {
          client.disconnect();
        }
      } catch {}
    }
  };
}

