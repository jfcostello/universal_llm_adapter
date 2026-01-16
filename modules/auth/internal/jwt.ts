import type http from 'http';
import httpModule from 'http';
import httpsModule from 'https';
import { createLocalJWKSet, jwtVerify } from 'jose';

import { LruMap } from '../../../kernel/index.js';

import type { AuthContext, JwtAuthConfig } from '../index.js';
import { makeUnauthorizedError } from './errors.js';
import { sha256Hex } from './sha256.js';
import { extractToken } from './token-extract.js';

type CacheEntry = { ctx: AuthContext; expiresAtMs: number };

type RemoteJwksState = {
  local?: ReturnType<typeof createLocalJWKSet>;
  fetchedAtMs?: number;
  pendingReload?: Promise<void>;
};

function normalizeClaimName(value: unknown, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : fallback;
}

function normalizeSeparator(value: unknown, fallback: string): string {
  const raw = String(value ?? '');
  return raw ? raw : fallback;
}

function parseScopes(value: unknown, separator: string): string[] | undefined {
  if (typeof value === 'string') {
    const parts = value
      .split(separator)
      .map(s => s.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(v => String(v ?? '').trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }

  return undefined;
}

function normalizeCacheMaxEntries(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10000;
  return Math.max(1, Math.floor(n));
}

function normalizeTimeoutMs(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function normalizeNonNegativeMs(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function normalizeMaxBytes(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function isJwksNoMatchingKey(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as any).code === 'ERR_JWKS_NO_MATCHING_KEY'
  );
}

async function fetchRemoteJwksJson(options: {
  url: URL;
  timeoutMs: number;
  maxBytes: number;
}): Promise<unknown> {
  type TransportModule = typeof httpModule | typeof httpsModule;

  const transportByProtocol: Record<string, TransportModule> = {
    'http:': httpModule,
    'https:': httpsModule
  };
  const transport = transportByProtocol[options.url.protocol];
  if (!transport) {
    throw new Error(`Unsupported protocol for jwksUrl: ${options.url.protocol}`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    const req = transport.request(
      options.url,
      {
        method: 'GET',
        headers: {
          accept: 'application/json, application/jwk-set+json'
        }
      },
      (res) => {
        res.on('error', finish);

        const status = res.statusCode as number;
        if (status !== 200) {
          res.resume();
          finish(new Error(`Expected 200 OK from JWKS endpoint, got ${status}`));
          return;
        }

        let bytes = 0;
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > options.maxBytes) {
            req.destroy();
            res.destroy();
            finish(new Error('JWKS response too large'));
            return;
          }
          chunks.push(Buffer.from(chunk as any));
        });

        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            finish(undefined, JSON.parse(text));
          } catch (error) {
            finish(error);
          }
        });
      }
    );

    req.on('error', finish);
    req.setTimeout(options.timeoutMs, () => {
      req.destroy();
      finish(new Error('JWKS request timeout'));
    });
    req.end();
  });
}

export function createJwtAuthenticator(config: JwtAuthConfig): {
  authenticate: (req: http.IncomingMessage) => Promise<AuthContext>;
} {
  const allowBearer = config.allowBearer ?? true;
  const allowHeader = config.allowHeader ?? false;
  const headerName = String(config.headerName ?? 'x-llm-adapter-jwt').toLowerCase();
  const realm = config.realm;

  const requireSubject = config.requireSubject ?? true;
  const requireExp = config.requireExp ?? true;

  const subjectClaim = normalizeClaimName(config.subjectClaim, 'sub');
  const tenantClaim = String(config.tenantClaim ?? '').trim() || undefined;
  const scopesClaim = normalizeClaimName(config.scopesClaim, 'scope');
  const scopesSeparator = normalizeSeparator(config.scopesSeparator, ' ');

  const cacheMaxEntries = normalizeCacheMaxEntries(config.cacheMaxEntries);
  const cache = new LruMap<string, CacheEntry>(cacheMaxEntries, { label: 'auth.jwt.token_cache' });
  const inflight = new Map<string, Promise<AuthContext>>();

  const jwksUrl = String(config.jwksUrl ?? '').trim();
  const remoteTimeoutMs = normalizeTimeoutMs((config as any).jwksTimeoutMs, 5000);
  const remoteCooldownMs = normalizeNonNegativeMs((config as any).jwksCooldownMs, 30000);
  const remoteCacheMaxAgeMs = normalizeNonNegativeMs((config as any).jwksCacheMaxAgeMs, 600000);
  const remoteMaxBytes = normalizeMaxBytes((config as any).jwksMaxBytes, 1024 * 1024);

  const remoteState: RemoteJwksState = {};
  const remoteUrl = jwksUrl ? new URL(jwksUrl) : null;

  async function reloadRemoteJwks(): Promise<void> {
    if (remoteState.pendingReload) return remoteState.pendingReload;

    const promise = (async () => {
      const json = await fetchRemoteJwksJson({
        url: remoteUrl!,
        timeoutMs: remoteTimeoutMs,
        maxBytes: remoteMaxBytes
      });
      if (!json || typeof json !== 'object' || !Array.isArray((json as any).keys)) {
        throw new Error('Invalid JWKS payload');
      }
      remoteState.local = createLocalJWKSet(json as any);
      remoteState.fetchedAtMs = Date.now();
    })().finally(() => {
      remoteState.pendingReload = undefined;
    });

    remoteState.pendingReload = promise;
    return promise;
  }

  async function maybeRefreshRemoteJwks(nowMs: number): Promise<void> {
    if (!remoteState.local) {
      await reloadRemoteJwks();
      return;
    }

    if (remoteCacheMaxAgeMs === 0) {
      try {
        await reloadRemoteJwks();
      } catch {
        // Keep going with last good set if present.
      }
      return;
    }

    const fetchedAtMs = remoteState.fetchedAtMs!;
    const stale = remoteCacheMaxAgeMs > 0 && fetchedAtMs > 0 && nowMs >= fetchedAtMs + remoteCacheMaxAgeMs;
    if (!stale) return;

    try {
      await reloadRemoteJwks();
    } catch {
      // If we have a stale key set, keep using it rather than failing every request.
    }
  }

  const keySet = jwksUrl
    ? (async (protectedHeader: any, token: any) => {
        const nowMs = Date.now();
        await maybeRefreshRemoteJwks(nowMs);

        const local = remoteState.local!;
        try {
          return await local(protectedHeader, token);
        } catch (error) {
          const nowMs2 = Date.now();
          const fetchedAtMs = remoteState.fetchedAtMs!;
          const inCooldown = remoteCooldownMs > 0 && fetchedAtMs > 0 && nowMs2 < fetchedAtMs + remoteCooldownMs;
          if (!inCooldown && isJwksNoMatchingKey(error)) {
            await reloadRemoteJwks();
            return remoteState.local!(protectedHeader, token);
          }
          throw error;
        }
      })
    : createLocalJWKSet(config.jwks as any);

  const issuer = config.issuer;
  const audience = config.audience;
  const algorithms = config.algorithms;
  const clockToleranceSeconds = config.clockToleranceSeconds;
  const clockTolerance =
    Number.isFinite(clockToleranceSeconds) ? Math.max(0, Number(clockToleranceSeconds)) : 0;

  async function verifyToken(token: string, digest: string): Promise<AuthContext> {
    let payload: any;
    try {
      const verified = await jwtVerify(token, keySet as any, {
        issuer,
        audience,
        algorithms: Array.isArray(algorithms) && algorithms.length > 0 ? algorithms : undefined,
        clockTolerance: clockTolerance > 0 ? clockTolerance : undefined
      });
      payload = verified.payload;
    } catch {
      throw makeUnauthorizedError({ realm });
    }

    if (!payload || typeof payload !== 'object') {
      throw makeUnauthorizedError({ realm });
    }

    const subject = String(payload?.[subjectClaim] ?? '').trim();
    if (requireSubject && !subject) {
      throw makeUnauthorizedError({ realm });
    }

    const expSeconds = Number(payload.exp);
    const hasExp = Number.isFinite(expSeconds);
    if (requireExp && !hasExp) {
      throw makeUnauthorizedError({ realm });
    }

    const expiresAtMs = hasExp ? (expSeconds + clockTolerance) * 1000 : 0;

    const tenant =
      tenantClaim ? String(payload?.[tenantClaim] ?? '').trim() || undefined : undefined;

    const scopes = parseScopes(payload?.[scopesClaim], scopesSeparator);

    const ctx: AuthContext = {
      mode: 'jwt',
      ...(subject ? { subject } : {}),
      ...(tenant ? { tenant } : {}),
      ...(scopes ? { scopes } : {})
    };

    if (hasExp) cache.set(digest, { ctx, expiresAtMs });

    return ctx;
  }

  return {
    authenticate: async (req) => {
      const token = extractToken(req, { allowBearer, allowHeader, headerName });
      if (!token) {
        throw makeUnauthorizedError({ realm });
      }

      const digest = sha256Hex(token);
      const nowMs = Date.now();

      const cached = cache.get(digest);
      if (cached) {
        if (nowMs < cached.expiresAtMs) return cached.ctx;
        cache.delete(digest);
      }

      const existing = inflight.get(digest);
      if (existing) return existing;

      const promise = verifyToken(token, digest).finally(() => {
        inflight.delete(digest);
      });
      inflight.set(digest, promise);
      return promise;
    }
  };
}
