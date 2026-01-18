import crypto from 'crypto';
import type http from 'http';

import { safeEqual } from '../../../../../../../modules/security/index.js';

import { makeProviderConfigError, makeUnauthorizedError, normalizePlainObject } from '../shared.js';

type WebhookAuthBearer = { type: 'bearer'; token: string };
type WebhookAuthHmac = {
  type: 'hmac';
  secretKey: string;
  algorithm: 'sha256' | 'sha512' | 'sha1';
  signatureHeader: string;
  timestampHeader: string;
  signaturePrefix: string;
  includeTimestamp: boolean;
  payloadFormat: string;
  signatureEncoding: 'hex' | 'base64';
  secretIsBase64: boolean;
  toleranceSeconds: number;
};

function readFirstHeader(req: http.IncomingMessage, name: string): string {
  const raw = (req.headers as any)?.[String(name).toLowerCase()];
  const value =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? String(raw[0] ?? '')
        : '';
  return value.trim();
}

function parseBearerToken(value: string): string {
  const raw = String(value).trim();
  if (!raw) return '';
  const match = /^bearer\s+(.+)$/i.exec(raw);
  if (!match) return '';
  return String(match[1]).trim();
}

export function parseWebhookAuth(providerDefaults: any): WebhookAuthBearer | WebhookAuthHmac {
  const defaults = normalizePlainObject(providerDefaults);
  const auth = normalizePlainObject(defaults.webhookAuth);
  const type = String(auth.type ?? 'bearer').trim().toLowerCase();

  if (type === 'hmac') {
    const secretKey = String(auth.secretKey ?? '').trim();
    const algorithmRaw = String(auth.algorithm ?? '').trim().toLowerCase();
    const algorithm = algorithmRaw === 'sha512' ? 'sha512' : algorithmRaw === 'sha1' ? 'sha1' : 'sha256';
    if (!secretKey) {
      throw makeProviderConfigError('Missing defaults.webhookAuth.secretKey');
    }
    if (!algorithmRaw) {
      throw makeProviderConfigError('Missing defaults.webhookAuth.algorithm');
    }

    const signatureHeader = String(auth.signatureHeader ?? 'x-signature').trim() || 'x-signature';
    const timestampHeader = String(auth.timestampHeader ?? 'x-timestamp').trim() || 'x-timestamp';
    const signaturePrefix = String(auth.signaturePrefix ?? '').trim();
    const includeTimestamp = auth.includeTimestamp === undefined ? true : Boolean(auth.includeTimestamp);
    const payloadFormat = String(auth.payloadFormat ?? '{timestamp}.{body}');
    const signatureEncodingRaw = String(auth.signatureEncoding ?? 'hex').trim().toLowerCase();
    const signatureEncoding = signatureEncodingRaw === 'base64' ? 'base64' : 'hex';
    const secretIsBase64 = Boolean(auth.secretIsBase64);
    const toleranceSecondsRaw = auth.toleranceSeconds;
    const toleranceSeconds =
      toleranceSecondsRaw === undefined || toleranceSecondsRaw === null || toleranceSecondsRaw === ''
        ? 300
        : Number(toleranceSecondsRaw);
    const toleranceSecondsNormalized = Number.isFinite(toleranceSeconds) && toleranceSeconds >= 0 ? Math.floor(toleranceSeconds) : 300;

    return {
      type: 'hmac',
      secretKey,
      algorithm,
      signatureHeader,
      timestampHeader,
      signaturePrefix,
      includeTimestamp,
      payloadFormat,
      signatureEncoding,
      secretIsBase64,
      toleranceSeconds: toleranceSecondsNormalized
    };
  }

  const token = String(auth.token ?? '').trim();
  if (!token) {
    throw makeProviderConfigError('Missing defaults.webhookAuth.token');
  }
  return { type: 'bearer', token };
}

function resolveSecretBytes(auth: WebhookAuthHmac): Buffer {
  return auth.secretIsBase64
    ? Buffer.from(auth.secretKey, 'base64')
    : Buffer.from(auth.secretKey, 'utf8');
}

function buildHmacPayload(options: { format: string; bodyText: string; timestamp: string; method: string; url: string; messageId: string }): string {
  return String(options.format)
    .replaceAll('{body}', options.bodyText)
    .replaceAll('{timestamp}', options.timestamp)
    .replaceAll('{method}', options.method)
    .replaceAll('{url}', options.url)
    .replaceAll('{svix-id}', options.messageId);
}

function computeHmacSignature(options: { auth: WebhookAuthHmac; payload: string }): string {
  const key = resolveSecretBytes(options.auth);
  const digest = crypto.createHmac(options.auth.algorithm, key).update(options.payload, 'utf8').digest();
  return options.auth.signatureEncoding === 'base64' ? digest.toString('base64') : digest.toString('hex');
}

export async function validateWebhookRequest(options: {
  req: http.IncomingMessage;
  method?: string;
  url?: string;
  bodyText?: string;
  providerDefaults?: any;
}): Promise<void> {
  const req = options.req;
  const auth = parseWebhookAuth(options.providerDefaults);

  if (auth.type === 'bearer') {
    const header = readFirstHeader(req, 'authorization');
    const provided = parseBearerToken(header);
    if (!provided) {
      throw makeUnauthorizedError('Unauthorized: missing Authorization bearer token');
    }
    if (!safeEqual(provided, auth.token)) {
      throw makeUnauthorizedError('Unauthorized: invalid Authorization bearer token');
    }
    return;
  }

  const signatureHeaderValue = readFirstHeader(req, auth.signatureHeader);
  const timestampHeaderValue = readFirstHeader(req, auth.timestampHeader);
  const signatureRaw = signatureHeaderValue.trim();
  if (!signatureRaw) {
    throw makeUnauthorizedError('Unauthorized: missing signature');
  }

  const signature = auth.signaturePrefix && signatureRaw.startsWith(auth.signaturePrefix)
    ? signatureRaw.slice(auth.signaturePrefix.length)
    : signatureRaw;

  const timestamp = auth.includeTimestamp ? timestampHeaderValue.trim() : '';
  if (auth.includeTimestamp && !timestamp) {
    throw makeUnauthorizedError('Unauthorized: missing timestamp');
  }

  if (auth.includeTimestamp && auth.toleranceSeconds > 0) {
    const n = Number(timestamp);
    if (!Number.isFinite(n)) {
      throw makeUnauthorizedError('Unauthorized: invalid timestamp');
    }
    const now = Date.now();
    const tsMs = n > 1e12 ? n : n * 1000;
    const diffSeconds = Math.abs(now - tsMs) / 1000;
    if (diffSeconds > auth.toleranceSeconds) {
      throw makeUnauthorizedError('Unauthorized: webhook timestamp outside tolerance');
    }
  }

  const bodyText = String(options.bodyText ?? '');
  const method = String(options.method ?? req.method ?? 'POST').toUpperCase();
  const url = String(options.url ?? '').trim();
  const messageId = readFirstHeader(req, 'svix-id');

  const payload = buildHmacPayload({
    format: auth.payloadFormat,
    bodyText,
    timestamp,
    method,
    url,
    messageId
  });
  const expected = computeHmacSignature({ auth, payload });

  if (!safeEqual(signature, expected)) {
    throw makeUnauthorizedError('Unauthorized: invalid signature');
  }
}
