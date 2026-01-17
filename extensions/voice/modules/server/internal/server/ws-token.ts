import crypto from 'crypto';

import { createSignedWsToken, verifySignedWsToken } from '../../../../../../modules/security/index.js';
import { normalizeFlag } from '../../../../../../modules/shared/index.js';

import type { VoiceMediaTokenPayload } from './types.js';

function getWsTokenSecret(): string {
  const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim();
  if (!raw) {
    throw new Error('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  }
  return raw;
}

export function getWebhookValidationRequired(): boolean {
  return normalizeFlag(process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED, true);
}

function getWsTokenTtlSeconds(): number {
  const maxTtlSeconds = 86400;
  const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS ?? '').trim();
  if (!raw) return 300;
  const n = Number(raw);
  const ttlSeconds = Math.floor(n);
  if (!Number.isFinite(n) || ttlSeconds <= 0 || ttlSeconds > maxTtlSeconds) {
    throw new Error(`Invalid LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS (max ${maxTtlSeconds})`);
  }
  return ttlSeconds;
}

export function getMediaWsMaxMessageBytes(): number {
  const raw = String(process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES ?? '').trim();
  if (!raw) return 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES');
  }
  return Math.floor(n);
}

export function getMediaWsMaxConcurrentSessions(): number {
  const raw = String(process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS ?? '').trim();
  if (!raw) return 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS');
  }
  return Math.floor(n);
}

export function mintVoiceMediaToken(options: { callConfigId: string; voiceProvider: string }): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = getWsTokenTtlSeconds();
  const payload: VoiceMediaTokenPayload = {
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce: crypto.randomBytes(18).toString('base64url'),
    purpose: 'voice_media',
    callConfigId: String(options.callConfigId),
    voiceProvider: String(options.voiceProvider)
  };
  return createSignedWsToken({ secret: getWsTokenSecret(), payload });
}

export function verifyVoiceMediaToken(token: string): { ok: true; payload: VoiceMediaTokenPayload } | { ok: false; error: any } {
  const res = verifySignedWsToken<VoiceMediaTokenPayload>({
    token,
    secret: getWsTokenSecret(),
    maxTtlSeconds: getWsTokenTtlSeconds(),
    expected: { purpose: 'voice_media' }
  });
  if (!res.ok) return res;

  const callConfigId = String((res.payload as any).callConfigId ?? '').trim();
  const voiceProvider = String((res.payload as any).voiceProvider ?? '').trim();
  if (!callConfigId || !voiceProvider) {
    return { ok: false, error: { code: 'missing_fields', message: 'Token payload missing required fields' } };
  }

  return { ok: true, payload: { ...(res.payload as any), callConfigId, voiceProvider } as VoiceMediaTokenPayload };
}

