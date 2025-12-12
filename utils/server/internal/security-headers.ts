import type http from 'http';

const DEFAULT_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

export function applySecurityHeaders(res: http.ServerResponse, enabled: boolean): void {
  if (!enabled) return;
  for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
    res.setHeader(key, value);
  }
}

