import type http from 'http';
import type { ApiKeyAuthConfig, AuthContext } from '../index.js';
import { makeUnauthorizedError } from './errors.js';
import { sha256Hex } from './sha256.js';
import { extractToken } from './token-extract.js';

function normalizeKeys(keys: ApiKeyAuthConfig['keys']): Map<string, string> {
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

export function createApiKeyAuthenticator(config: ApiKeyAuthConfig): {
  authenticate: (req: http.IncomingMessage) => Promise<AuthContext>;
} {
  const allowBearer = config.allowBearer ?? true;
  const allowHeader = config.allowHeader ?? true;
  const headerName = (config.headerName ?? 'x-api-key').toLowerCase();
  const realm = config.realm;

  const keyDigestToId = normalizeKeys(config.keys);

  return {
    authenticate: async (req) => {
      const token = extractToken(req, { allowBearer, allowHeader, headerName });
      if (!token) {
        throw makeUnauthorizedError({ realm });
      }

      const id = keyDigestToId.get(sha256Hex(token));
      if (!id) {
        throw makeUnauthorizedError({ realm });
      }

      return { mode: 'apiKey', subject: id };
    }
  };
}
