import type { ApiKeyAuthConfig, ProxySignedAuthConfig } from '../index.js';
import { sha256Hex } from './sha256.js';

export function normalizeApiKeyKeys(keys: ApiKeyAuthConfig['keys']): Map<string, string> {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('apiKey auth requires at least one key');
  }

  function normalizeSha256(value: string): string {
    const trimmed = value.trim();
    const hex = trimmed.toLowerCase().startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error('apiKey auth key sha256 must be 64 hex characters');
    }
    return hex.toLowerCase();
  }

  const map = new Map<string, string>();
  for (const entry of keys) {
    const id = String(entry?.id ?? '').trim();
    const token = String(entry?.token ?? '').trim();
    const sha256 = String((entry as any)?.sha256 ?? '').trim();
    if (!id) {
      throw new Error('apiKey auth key id is required');
    }

    if (token && sha256) {
      throw new Error('apiKey auth key must specify exactly one of token or sha256');
    }

    let digest: string;
    if (token) {
      digest = sha256Hex(token);
    } else if (sha256) {
      digest = normalizeSha256(sha256);
    } else {
      throw new Error('apiKey auth key token or sha256 is required');
    }

    if (map.has(digest)) {
      throw new Error('apiKey auth key digest must be unique');
    }

    map.set(digest, id);
  }

  return map;
}

export function normalizeProxySignedKeys(keys: ProxySignedAuthConfig['keys']): Map<string, string> {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('proxySigned auth requires at least one key');
  }

  const map = new Map<string, string>();
  for (const entry of keys) {
    const id = String(entry?.id ?? '').trim();
    const secret = String(entry?.secret ?? '').trim();
    if (!id) {
      throw new Error('proxySigned auth key id is required');
    }
    if (!secret) {
      throw new Error('proxySigned auth key secret is required');
    }
    if (map.has(id)) {
      throw new Error('proxySigned auth key id must be unique');
    }
    map.set(id, secret);
  }
  return map;
}

