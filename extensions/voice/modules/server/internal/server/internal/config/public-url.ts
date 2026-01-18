import type http from 'http';

import { normalizeFlag } from '../../../../../../../../modules/shared/index.js';

function getVoicePublicBaseUrlOverride(): string | undefined {
  const raw = String(process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL ?? '').trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid LLM_ADAPTER_VOICE_PUBLIC_BASE_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid LLM_ADAPTER_VOICE_PUBLIC_BASE_URL');
  }
  return parsed.origin;
}

function sanitizeForwardedProto(raw: unknown): 'http' | 'https' | undefined {
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]!.trim().toLowerCase();
  if (first === 'http' || first === 'https') return first;
  return undefined;
}

function sanitizeHostHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]!.trim();
  if (!first) return undefined;
  if (/[\r\n\t ]/.test(first)) return undefined;
  if (first.includes('/') || first.includes('\\') || first.includes('@') || first.includes('://')) return undefined;

  try {
    const parsed = new URL(`http://${first}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed.host;
  } catch {
    return undefined;
  }
}

export function getPublicHttpBaseUrl(req: http.IncomingMessage): string {
  const override = getVoicePublicBaseUrlOverride();
  if (override) return override;

  const headers = req.headers ?? {};
  const trustProxyHeaders = normalizeFlag(process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS, false);

  const fallbackProto = (req.socket as any)?.encrypted ? 'https' : 'http';
  const proto = (trustProxyHeaders ? sanitizeForwardedProto(headers['x-forwarded-proto']) : undefined) ?? fallbackProto;

  const forwardedHost = trustProxyHeaders ? sanitizeHostHeader(headers['x-forwarded-host']) : undefined;
  const host = forwardedHost ?? sanitizeHostHeader(headers.host) ?? 'localhost';

  return `${proto}://${host}`;
}

export function toWsUrl(httpBaseUrl: string, pathname: string, searchParams: Record<string, string>): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = '';
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}
