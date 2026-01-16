import type http from 'http';
import type { AuthConfig, AuthContext, Authenticator } from '../index.js';
import { createApiKeyAuthenticator } from './api-key.js';
import { createProxySignedAuthenticator } from './proxy-signed.js';

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
    return createApiKeyAuthenticator(config as any);
  }

  if (mode === 'proxySigned') {
    return createProxySignedAuthenticator(config as any);
  }

  if (mode === 'jwt') {
    const cfg: any = config as any;
    if (!cfg.jwksUrl && !cfg.jwks) {
      throw new Error('jwt auth requires jwksUrl or jwks');
    }
    return createLazyAuthenticator(async () => {
      const { createJwtAuthenticator } = await import('./jwt.js');
      return createJwtAuthenticator(cfg);
    });
  }

  throw new Error(`Unsupported auth mode: ${String(mode)}`);
}
