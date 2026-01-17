import type http from 'http';
import type { ApiKeyAuthConfig, AuthContext } from '../index.js';
import { makeUnauthorizedError } from './errors.js';
import { normalizeApiKeyKeys } from './key-normalizers.js';
import { sha256Hex } from './sha256.js';
import { extractToken } from './token-extract.js';

export function createApiKeyAuthenticator(config: ApiKeyAuthConfig): {
  authenticate: (req: http.IncomingMessage) => Promise<AuthContext>;
} {
  const allowBearer = config.allowBearer ?? true;
  const allowHeader = config.allowHeader ?? true;
  const headerName = (config.headerName ?? 'x-api-key').toLowerCase();
  const realm = config.realm;

  const keyDigestToId = normalizeApiKeyKeys(config.keys);

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
