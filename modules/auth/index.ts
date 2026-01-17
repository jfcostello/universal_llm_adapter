import type http from 'http';
import { createAuthenticatorInternal } from './internal/create-authenticator.js';

export type AuthMode = 'none' | 'apiKey' | 'jwt' | 'proxySigned';

export interface AuthContext {
  mode: AuthMode;
  subject?: string;
  tenant?: string;
  scopes?: string[];
}

export interface NoneAuthConfig {
  mode: 'none';
}

export interface ApiKeyAuthConfig {
  mode: 'apiKey';
  allowBearer?: boolean;
  allowHeader?: boolean;
  headerName?: string;
  realm?: string;
  keys: Array<{ id: string; token?: string; sha256?: string }>;
}

export interface JwtAuthConfig {
  mode: 'jwt';
  allowBearer?: boolean;
  allowHeader?: boolean;
  headerName?: string;
  realm?: string;
  /**
   * Static public key in SPKI PEM format.
   * Useful for enterprise deployments that do not use JWKS.
   */
  spki?: string;
  jwksUrl?: string;
  jwks?: unknown;
  jwksTimeoutMs?: number;
  jwksCooldownMs?: number;
  jwksCacheMaxAgeMs?: number;
  jwksMaxBytes?: number;
  issuer?: string | string[];
  audience?: string | string[];
  algorithms?: string[];
  clockToleranceSeconds?: number;
  subjectClaim?: string;
  tenantClaim?: string;
  scopesClaim?: string;
  scopesSeparator?: string;
  requireSubject?: boolean;
  requireExp?: boolean;
  cacheMaxEntries?: number;
}

export interface ProxySignedAuthConfig {
  mode: 'proxySigned';
  realm?: string;
  headers?: {
    signature?: string;
    keyId?: string;
    timestamp?: string;
    subject?: string;
    tenant?: string;
    scopes?: string;
  };
  maxSkewSeconds?: number;
  scopesSeparator?: string;
  keys: Array<{ id: string; secret: string }>;
}

export type AuthConfig = NoneAuthConfig | ApiKeyAuthConfig | JwtAuthConfig | ProxySignedAuthConfig;

export interface AuthErrorLike extends Error {
  statusCode: number;
  code: string;
  headers?: Record<string, string>;
}

export interface Authenticator {
  authenticate: (req: http.IncomingMessage) => Promise<AuthContext>;
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  return createAuthenticatorInternal(config);
}
