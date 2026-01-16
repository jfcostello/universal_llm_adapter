import crypto from 'crypto';
import type http from 'http';

import { safeEqual } from '../../security/index.js';

import type { AuthContext, ProxySignedAuthConfig } from '../index.js';
import { makeUnauthorizedError } from './errors.js';

function normalizeHeaderName(value: unknown, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  return (trimmed || fallback).toLowerCase();
}

function getHeader(req: http.IncomingMessage, headerName: string): string | null {
  const headers = (req as any)?.headers ?? {};
  if (!headers || typeof headers !== 'object') return null;
  const raw = (headers as any)[headerName.toLowerCase()];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(raw) && typeof raw[0] === 'string') {
    const trimmed = raw[0].trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function normalizeSkewSeconds(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.max(0, Math.floor(n));
}

function normalizeSeparator(value: unknown, fallback: string): string {
  const raw = String(value ?? '');
  return raw ? raw : fallback;
}

function parseScopes(value: string | null, separator: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(separator)
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function normalizeKeys(keys: ProxySignedAuthConfig['keys']): Map<string, string> {
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

export function createProxySignedAuthenticator(config: ProxySignedAuthConfig): {
  authenticate: (req: http.IncomingMessage) => Promise<AuthContext>;
} {
  const realm = config.realm;
  const maxSkewSeconds = normalizeSkewSeconds(config.maxSkewSeconds);
  const scopesSeparator = normalizeSeparator(config.scopesSeparator, ' ');

  const signatureHeader = normalizeHeaderName(config.headers?.signature, 'x-llm-adapter-signature');
  const keyIdHeader = normalizeHeaderName(config.headers?.keyId, 'x-llm-adapter-key-id');
  const timestampHeader = normalizeHeaderName(config.headers?.timestamp, 'x-llm-adapter-timestamp');
  const subjectHeader = normalizeHeaderName(config.headers?.subject, 'x-llm-adapter-subject');
  const tenantHeader = normalizeHeaderName(config.headers?.tenant, 'x-llm-adapter-tenant');
  const scopesHeader = normalizeHeaderName(config.headers?.scopes, 'x-llm-adapter-scopes');

  const keyIdToSecret = normalizeKeys(config.keys);
  const requireKeyId = keyIdToSecret.size > 1;
  const onlyKey = keyIdToSecret.keys().next().value as string;
  const onlySecret = keyIdToSecret.get(onlyKey) as string;

  function unauthorized(): never {
    throw makeUnauthorizedError({ realm });
  }

  return {
    authenticate: async (req) => {
      const signature = getHeader(req, signatureHeader);
      const timestampRaw = getHeader(req, timestampHeader);
      const subject = getHeader(req, subjectHeader);
      const tenant = getHeader(req, tenantHeader);
      const scopesRaw = getHeader(req, scopesHeader);
      const keyId = getHeader(req, keyIdHeader);

      if (!signature || !timestampRaw || !subject) {
        unauthorized();
      }

      const timestampSeconds = Number(timestampRaw);
      if (!Number.isFinite(timestampSeconds)) {
        unauthorized();
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - timestampSeconds) > maxSkewSeconds) {
        unauthorized();
      }

      let secret: string;
      let resolvedKeyId: string;
      if (requireKeyId) {
        if (!keyId) unauthorized();
        const found = keyIdToSecret.get(keyId);
        if (!found) unauthorized();
        secret = found;
        resolvedKeyId = keyId;
      } else {
        secret = keyId ? (keyIdToSecret.get(keyId) ?? onlySecret) : onlySecret;
        resolvedKeyId = keyId ?? onlyKey;
      }

      const method = String(req.method ?? '').toUpperCase();
      const url = String(req.url ?? '/');
      const signedPayload = [
        'llm-adapter-proxy-signed-v1',
        String(timestampSeconds),
        method,
        url,
        subject,
        tenant ?? '',
        scopesRaw ?? '',
        resolvedKeyId
      ].join('\n');

      const expectedSig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
      if (!safeEqual(expectedSig, String(signature).toLowerCase())) {
        unauthorized();
      }

      const scopes = parseScopes(scopesRaw, scopesSeparator);

      return {
        mode: 'proxySigned',
        subject,
        ...(tenant ? { tenant } : {}),
        ...(scopes ? { scopes } : {})
      };
    }
  };
}

