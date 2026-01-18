import type http from 'http';

import crypto from 'crypto';

import { makeHttpError } from '../../../../../../../../modules/shared/index.js';

export function parseUrl(rawUrl: string | undefined): URL | null {
  const raw = rawUrl ?? '/';
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return null;
  }
}

export function normalizeRequestId(value: string): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0]!.trim();
  const cleaned = first.replace(/[\r\n\t]/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, 128);
}

export function readRequestId(req: http.IncomingMessage): string | undefined {
  const readHeader = (name: string): string => {
    const raw = req.headers?.[name];
    const first =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? String(raw[0] ?? '')
          : '';
    return first.trim();
  };

  return (
    normalizeRequestId(readHeader('x-request-id')) ??
    normalizeRequestId(readHeader('x-correlation-id'))
  );
}

export function normalizeIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const maxBytes = 512;
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed;

  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  return `sha256:${hash}`;
}

export function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function readTextBody(
  req: http.IncomingMessage,
  options: { maxBytes: number; timeoutMs: number }
): Promise<string> {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : Number.POSITIVE_INFINITY;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;

  let input = '';
  let bytes = 0;
  let timeout: NodeJS.Timeout | undefined;

  const readPromise = (async () => {
    req.setEncoding('utf-8');
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        throw makeHttpError({ message: 'Request body too large', statusCode: 413, code: 'payload_too_large' });
      }
      input += chunk;
    }
    return input;
  })();

  try {
    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(makeHttpError({ message: 'Request body read timed out', statusCode: 408, code: 'body_read_timeout' }));
        }, timeoutMs);
      });
      return await Promise.race([readPromise, timeoutPromise]);
    }
    return await readPromise;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
