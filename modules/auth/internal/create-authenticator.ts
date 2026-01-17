import type http from 'http';
import type { AuthConfig, AuthContext, Authenticator } from '../index.js';
import { normalizeApiKeyKeys, normalizeProxySignedKeys } from './key-normalizers.js';

function createLazyAuthenticator(loader: () => Promise<Authenticator>): Authenticator {
  let promise: Promise<Authenticator> | undefined;
  return {
    authenticate: async (req: http.IncomingMessage): Promise<AuthContext> => {
      if (!promise) promise = loader();
      const impl = await promise;
      return impl.authenticate(req);
    }
  };
}

export function createAuthenticatorInternal(config: AuthConfig): Authenticator {
  const mode = (config as any)?.mode;

  if (mode === 'none') {
    return {
      authenticate: async (_req: http.IncomingMessage): Promise<AuthContext> => ({ mode: 'none' })
    };
  }

  if (mode === 'apiKey') {
    const cfg: any = config as any;
    normalizeApiKeyKeys(cfg?.keys);
    return createLazyAuthenticator(async () => {
      const { createApiKeyAuthenticator } = await import('./api-key.js');
      return createApiKeyAuthenticator(cfg);
    });
  }

  if (mode === 'proxySigned') {
    const cfg: any = config as any;
    normalizeProxySignedKeys(cfg?.keys);
    return createLazyAuthenticator(async () => {
      const { createProxySignedAuthenticator } = await import('./proxy-signed.js');
      return createProxySignedAuthenticator(cfg);
    });
  }

  if (mode === 'jwt') {
    const cfg: any = config as any;
    if (!cfg.jwksUrl && !cfg.jwks && !cfg.spki) {
      throw new Error('jwt auth requires jwksUrl, jwks, or spki');
    }
    return createLazyAuthenticator(async () => {
      const { createJwtAuthenticator } = await import('./jwt.js');
      return createJwtAuthenticator(cfg);
    });
  }

  throw new Error(`Unsupported auth mode: ${String(mode)}`);
}
