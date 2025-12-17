import crypto from 'crypto';

export interface SignedWsTokenPayload {
  iat: number;
  exp: number;
  nonce: string;
  [key: string]: unknown;
}

export interface SignedWsTokenError {
  code: string;
  message: string;
}

export type VerifySignedWsTokenResult<TPayload extends SignedWsTokenPayload> =
  | { ok: true; payload: TPayload }
  | { ok: false; error: SignedWsTokenError };

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeError(code: string, message: string): VerifySignedWsTokenResult<any> {
  return { ok: false, error: { code, message } };
}

function isBase64Url(input: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(input);
}

export function createSignedWsToken<TPayload extends SignedWsTokenPayload>(options: {
  secret: string;
  payload: TPayload;
}): string {
  const secret = String(options.secret ?? '');
  if (!secret) {
    throw new Error('Missing secret');
  }

  const payload = options.payload as any;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload');
  }

  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || typeof payload.nonce !== 'string' || !payload.nonce) {
    throw new Error('Payload must include iat, exp, nonce');
  }

  const json = JSON.stringify(options.payload);
  const payloadB64 = base64UrlEncode(Buffer.from(json, 'utf-8'));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64UrlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

export function verifySignedWsToken<TPayload extends SignedWsTokenPayload>(options: {
  token: string;
  secret: string;
  nowSeconds?: number;
  clockSkewSeconds?: number;
  maxTtlSeconds?: number;
  expected?: Record<string, unknown>;
}): VerifySignedWsTokenResult<TPayload> {
  const token = String(options.token ?? '').trim();
  if (!token) {
    return makeError('missing_token', 'Missing token');
  }

  const secret = String(options.secret ?? '');
  if (!secret) {
    return makeError('missing_secret', 'Missing secret');
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return makeError('invalid_format', 'Invalid token format');
  }
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) {
    return makeError('invalid_format', 'Invalid token format');
  }
  if (!isBase64Url(payloadB64) || !isBase64Url(sigB64)) {
    return makeError('invalid_format', 'Invalid token format');
  }

  const expectedSigB64 = base64UrlEncode(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  if (!safeEqual(expectedSigB64, sigB64)) {
    return makeError('invalid_signature', 'Invalid token signature');
  }

  let payload: any;
  try {
    const json = base64UrlDecode(payloadB64).toString('utf-8');
    payload = JSON.parse(json);
  } catch {
    return makeError('invalid_payload', 'Invalid token payload');
  }

  if (!payload || typeof payload !== 'object') {
    return makeError('invalid_payload', 'Invalid token payload');
  }

  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  const nonce = payload.nonce;
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || typeof nonce !== 'string' || !nonce) {
    return makeError('missing_fields', 'Token payload missing required fields');
  }

  const nowSeconds = Number.isFinite(options.nowSeconds) ? Number(options.nowSeconds) : Math.floor(Date.now() / 1000);
  const rawClockSkew = Number(options.clockSkewSeconds ?? 5);
  const clockSkew = Number.isFinite(rawClockSkew) ? Math.max(0, rawClockSkew) : 5;
  const rawMaxTtlSeconds = Number(options.maxTtlSeconds ?? 300);
  const maxTtlSeconds = Number.isFinite(rawMaxTtlSeconds) ? Math.max(0, rawMaxTtlSeconds) : 300;

  if (iat > nowSeconds + clockSkew) {
    return makeError('not_yet_valid', 'Token not yet valid');
  }
  if (exp < nowSeconds - clockSkew) {
    return makeError('expired', 'Token expired');
  }

  const ttl = exp - iat;
  if (ttl <= 0) {
    return makeError('invalid_ttl', 'Invalid token TTL');
  }
  if (ttl > maxTtlSeconds) {
    return makeError('ttl_too_long', 'Token TTL too long');
  }

  if (options.expected) {
    for (const [key, value] of Object.entries(options.expected)) {
      if (payload[key] !== value) {
        return makeError('binding_mismatch', `Token binding mismatch: ${key}`);
      }
    }
  }

  return { ok: true, payload: payload as TPayload };
}
