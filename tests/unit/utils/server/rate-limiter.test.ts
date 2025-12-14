import { jest } from '@jest/globals';
import { createRateLimiter, getClientIp } from '@/modules/server/internal/security/rate-limiter.ts';

describe('utils/server rate-limiter', () => {
  test('disabled limiter allows all', () => {
    const limiter = createRateLimiter({ enabled: false } as any);
    expect(() => limiter.check('client')).not.toThrow();
  });

  test('token bucket enforces burst', () => {
    const limiter = createRateLimiter({
      enabled: true,
      requestsPerMinute: 60,
      burst: 1
    });
    limiter.check('c1');
    expect(() => limiter.check('c1')).toThrow(/rate/i);
  });

  test('refills over time', () => {
    jest.useFakeTimers();
    const limiter = createRateLimiter({
      enabled: true,
      requestsPerMinute: 60,
      burst: 1
    });
    limiter.check('c1');
    expect(() => limiter.check('c1')).toThrow();

    jest.advanceTimersByTime(1000); // 1 token/sec
    expect(() => limiter.check('c1')).not.toThrow();
    jest.useRealTimers();
  });

  test('uses fallback values when limits omitted', () => {
    const limiter = createRateLimiter({ enabled: true } as any);
    expect(() => limiter.check('c1')).not.toThrow();
  });

  test('getClientIp respects trustProxyHeaders', () => {
    const req: any = {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      socket: { remoteAddress: '9.9.9.9' }
    };
    expect(getClientIp(req, false)).toBe('9.9.9.9');
    expect(getClientIp(req, true)).toBe('1.2.3.4');
  });

  test('getClientIp defaults trustProxyHeaders to false', () => {
    const req: any = { headers: { 'x-forwarded-for': '1.1.1.1' }, socket: { remoteAddress: '2.2.2.2' } };
    expect(getClientIp(req)).toBe('2.2.2.2');
  });

  test('getClientIp falls back when forwarded header missing', () => {
    const req: any = { headers: {}, socket: { remoteAddress: '8.8.8.8' } };
    expect(getClientIp(req, true)).toBe('8.8.8.8');
  });

  test('getClientIp returns undefined when no remote address', () => {
    const req: any = { headers: {}, socket: { remoteAddress: undefined } };
    expect(getClientIp(req, false)).toBeUndefined();
  });
});
