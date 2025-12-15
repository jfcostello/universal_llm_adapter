import { applyCors } from '@/modules/server/internal/security/cors.ts';

describe('utils/server cors', () => {
  function makeRes() {
    const headers: Record<string, any> = {};
    return {
      headers,
      setHeader: (k: string, v: any) => (headers[k.toLowerCase()] = v),
      writeHead: (code: number) => {
        (headers as any).status = code;
      },
      end: () => {}
    } as any;
  }

  test('returns false when cors disabled', () => {
    const req: any = { method: 'POST', headers: {} };
    const res = makeRes();
    expect(applyCors(req, res, { enabled: false } as any)).toBe(false);
  });

  test('handles preflight and sets headers', () => {
    const req: any = {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-headers': 'content-type' }
    };
    const res = makeRes();
    const handled = applyCors(req, res, {
      enabled: true,
      allowedOrigins: ['https://example.com'],
      allowedHeaders: ['content-type'],
      allowCredentials: false
    });
    expect(handled).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(res.headers.status).toBe(204);
  });

  test('sets credentials header on non-preflight when enabled', () => {
    const req: any = { method: 'POST', headers: { origin: 'https://example.com' } };
    const res = makeRes();
    const handled = applyCors(req, res, {
      enabled: true,
      allowedOrigins: ['https://example.com'],
      allowedHeaders: ['content-type'],
      allowCredentials: true
    });
    expect(handled).toBe(false);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('allows wildcard origins', () => {
    const req: any = { method: 'POST', headers: { origin: 'https://foo.com' } };
    const res = makeRes();
    applyCors(req, res, {
      enabled: true,
      allowedOrigins: '*',
      allowedHeaders: []
    } as any);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('handles missing origin gracefully', () => {
    const req: any = { method: 'POST', headers: {} };
    const res = makeRes();
    const handled = applyCors(req, res, {
      enabled: true,
      allowedOrigins: ['https://example.com']
    } as any);
    expect(handled).toBe(false);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('treats undefined method as non-preflight', () => {
    const req: any = { method: undefined, headers: { origin: 'https://example.com' } };
    const res = makeRes();
    const handled = applyCors(req, res, {
      enabled: true,
      allowedOrigins: ['https://example.com'],
      allowedHeaders: []
    } as any);
    expect(handled).toBe(false);
  });

  test('does not set allow-origin when origin not in allowlist', () => {
    const req: any = { method: 'POST', headers: { origin: 'https://denied.com' } };
    const res = makeRes();
    applyCors(req, res, {
      enabled: true,
      allowedOrigins: ['https://allowed.com'],
      allowedHeaders: []
    } as any);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('defaults allowedOrigins to empty list when omitted', () => {
    const req: any = { method: 'POST', headers: { origin: 'https://example.com' } };
    const res = makeRes();
    applyCors(req, res, { enabled: true } as any);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
