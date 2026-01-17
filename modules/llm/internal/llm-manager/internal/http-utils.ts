import type { ProviderManifest } from '../../../../../kernel/index.js';

export function isRateLimitResponse(provider: ProviderManifest, response: any): boolean {
  if (!provider.retryWords || provider.retryWords.length === 0) {
    return false;
  }

  // Treat HTTP 429 as rate limit regardless of body shape.
  if (response?.status === 429) {
    return true;
  }

  // A Retry-After header is a strong signal even when bodies are not standardized.
  const retryAfter = response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'];
  if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== '') {
    return true;
  }

  const keywords = provider.retryWords.map(w => w.toLowerCase());
  const responseText = JSON.stringify(response.data).toLowerCase();
  return keywords.some(keyword => responseText.includes(keyword));
}

export function stripReasoning(payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  if (!Object.prototype.hasOwnProperty.call(payload, 'reasoning')) {
    return payload;
  }

  const next = { ...payload };
  delete next.reasoning;
  return next;
}

export function isReasoningExplicitlyDisabled(payload: any): boolean {
  const reasoning = payload?.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
    return false;
  }
  return reasoning.enabled === false || reasoning.exclude === true;
}

export function isUnsupportedReasoningParamError(data: any): boolean {
  const error = data?.error;
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as any).code;
  if (code !== 'unsupported_parameter') {
    return false;
  }

  const param = (error as any).param;
  if (typeof param === 'string' && (param === 'reasoning' || param.startsWith('reasoning.'))) {
    return true;
  }

  const message = (error as any).message;
  if (typeof message === 'string') {
    const normalized = message.toLowerCase();
    return normalized.includes('unsupported parameter') && normalized.includes('reasoning');
  }

  return false;
}

export function isReasoningDisabledNotAllowedError(data: any): boolean {
  const message = data?.error?.message;
  if (typeof message !== 'string') {
    return false;
  }
  const normalized = message.toLowerCase();
  return normalized.includes('reasoning') && normalized.includes('cannot be disabled');
}

export function isHttpUrlTemplate(urlTemplate: unknown): boolean {
  if (typeof urlTemplate !== 'string') {
    return false;
  }
  const normalized = urlTemplate.trim().toLowerCase();
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}
