import crypto from 'crypto';

import { makeHttpError } from '../../../../../../modules/shared/index.js';

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function splitMediaWsUrl(mediaWsUrl: string): { wsUrl: string; token: string } {
  const raw = String(mediaWsUrl);
  try {
    const url = new URL(raw);
    const token = String(url.searchParams.get('token') ?? '').trim();
    url.searchParams.delete('token');
    return { wsUrl: url.toString(), token };
  } catch {
    return { wsUrl: raw, token: '' };
  }
}

export function buildTwiMLDial(options: { targetNumber: string; callerId?: string; timeout: number }): string {
  const targetNumber = escapeXmlAttr(String(options.targetNumber));
  const callerIdAttr = options.callerId ? ` callerId="${escapeXmlAttr(String(options.callerId))}"` : '';
  const timeout = Math.max(1, Math.min(600, Math.floor(options.timeout)));

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Dial${callerIdAttr} timeout="${timeout}">${targetNumber}</Dial>\n</Response>\n`;
}

export function buildTwiMLConnectStream(options: { wsUrl: string; parameters: Record<string, string> }): string {
  const wsUrl = escapeXmlAttr(String(options.wsUrl));

  const params = Object.entries(options.parameters)
    .filter(([_, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `      <Parameter name=\"${escapeXmlAttr(String(k))}\" value=\"${escapeXmlAttr(String(v))}\" />`)
    .join('\n');

  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Connect>\n    <Stream url=\"${wsUrl}\">\n${params}\n    </Stream>\n  </Connect>\n</Response>\n`;
}

export function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const token = Buffer.from(raw, 'utf-8').toString('base64');
  return `Basic ${token}`;
}

export function sanitizeFsToken(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128);
}

export function sleepUnref(ms: number): Promise<void> | undefined {
  const durationMs = Math.max(0, Math.floor(ms));
  if (durationMs <= 0) return undefined;

  return new Promise<void>((resolve) => {
    const timeoutId: any = setTimeout(resolve, durationMs);
    if (timeoutId && typeof timeoutId.unref === 'function') {
      try {
        timeoutId.unref();
      } catch {}
    }
  });
}

export function isCallLogCaptureEnabled(): boolean {
  if (process.env.LLM_ADAPTER_DISABLE_FILE_LOGS === '1') return false;
  const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === 'disabled') {
    return false;
  }
  return true;
}

export function makeProviderConfigError(message: string): Error {
  return makeHttpError({ message, statusCode: 500, code: 'provider_config_error' });
}

export function makeUnauthorizedError(message: string): Error {
  return makeHttpError({ message, statusCode: 401, code: 'unauthorized' });
}

export function computeRequestSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map(k => `${k}${params[k] ?? ''}`).join('');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

