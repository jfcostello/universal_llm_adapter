import crypto from 'crypto';
import type http from 'http';

export interface AuthConfig {
  enabled: boolean;
  allowBearer?: boolean;
  allowApiKeyHeader?: boolean;
  headerName?: string;
  apiKeys?: string[] | string;
  hashedKeys?: string[] | string;
  realm?: string;
}

export type AuthorizeCallback =
  | ((req: http.IncomingMessage) => boolean | Promise<boolean>)
  | undefined;

export function normalizeKeyList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(v => String(v).trim())
      .filter(v => v.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(v => v.trim())
      .filter(v => v.length > 0);
  }
  return [];
}

function stripHashPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('sha256:')) return trimmed.slice('sha256:'.length);
  return trimmed;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // keep timing roughly consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeAuthError(message: string, statusCode = 401, code = 'unauthorized') {
  const err = new Error(message);
  (err as any).statusCode = statusCode;
  (err as any).code = code;
  return err;
}

function extractToken(req: http.IncomingMessage, allowBearer: boolean, allowApiKeyHeader: boolean, headerName: string): string | null {
  const headers = req.headers ?? {};

  if (allowBearer) {
    const authHeader = headers['authorization'];
    if (typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) return match[1].trim();
    }
  }

  if (allowApiKeyHeader) {
    const keyHeader = headers[headerName.toLowerCase()];
    if (typeof keyHeader === 'string' && keyHeader.trim()) {
      return keyHeader.trim();
    }
  }

  return null;
}

export async function assertAuthorized(
  req: http.IncomingMessage,
  config: AuthConfig,
  authorize?: AuthorizeCallback
): Promise<string | undefined> {
  if (!config?.enabled) return undefined;

  const allowBearer = config.allowBearer ?? true;
  const allowApiKeyHeader = config.allowApiKeyHeader ?? true;
  const headerName = (config.headerName ?? 'x-api-key').toLowerCase();

  const apiKeys = normalizeKeyList(config.apiKeys);
  const hashedKeys = normalizeKeyList(config.hashedKeys).map(stripHashPrefix);

  const token = extractToken(req, allowBearer, allowApiKeyHeader, headerName);
  if (!token) {
    throw makeAuthError('Unauthorized: missing credentials');
  }

  const rawOk = apiKeys.some(k => safeEqual(k, token));
  let hashOk = false;
  if (!rawOk && hashedKeys.length > 0) {
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    hashOk = hashedKeys.some(h => safeEqual(h, digest));
  }

  if (!rawOk && !hashOk) {
    throw makeAuthError('Unauthorized: invalid credentials');
  }

  if (authorize) {
    const allowed = await authorize(req);
    if (!allowed) {
      throw makeAuthError('Forbidden', 403, 'forbidden');
    }
  }

  return token;
}

