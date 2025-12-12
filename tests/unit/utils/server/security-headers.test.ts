import { applySecurityHeaders } from '@/utils/server/internal/security/security-headers.ts';

describe('utils/server security headers', () => {
  function makeRes() {
    const headers: Record<string, any> = {};
    return {
      headers,
      setHeader: (k: string, v: any) => (headers[k.toLowerCase()] = v)
    } as any;
  }

  test('sets defaults when enabled', () => {
    const res = makeRes();
    applySecurityHeaders(res, true);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  test('no-op when disabled', () => {
    const res = makeRes();
    applySecurityHeaders(res, false);
    expect(Object.keys(res.headers).length).toBe(0);
  });
});
