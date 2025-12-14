import crypto from 'crypto';
import { assertAuthorized, normalizeKeyList } from '@/modules/server/internal/security/auth.ts';

describe('utils/server auth', () => {
  function makeReq(headers: Record<string, string>): any {
    return { headers, socket: { remoteAddress: '127.0.0.1' } };
  }

  test('no-op when auth disabled', () => {
    const req = makeReq({});
    return expect(
      assertAuthorized(req, { enabled: false, apiKeys: [] } as any)
    ).resolves.toBeUndefined();
  });

  test('accepts bearer token when enabled', async () => {
    const req = makeReq({ authorization: 'Bearer key-1' });
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: true,
        allowApiKeyHeader: false,
        headerName: 'x-api-key',
        apiKeys: ['key-1']
      } as any)
    ).resolves.toBe('key-1');
  });

  test('accepts x-api-key header when enabled', async () => {
    const req = makeReq({ 'x-api-key': 'key-2' });
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: false,
        allowApiKeyHeader: true,
        headerName: 'x-api-key',
        apiKeys: ['key-2']
      } as any)
    ).resolves.toBe('key-2');
  });

  test('supports multiple keys (rotation)', async () => {
    const req = makeReq({ authorization: 'Bearer key-b' });
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: true,
        allowApiKeyHeader: true,
        headerName: 'x-api-key',
        apiKeys: ['key-a', 'key-b']
      } as any)
    ).resolves.toBe('key-b');
  });

  test('rejects missing credentials with 401', async () => {
    const req = makeReq({});
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: true,
        allowApiKeyHeader: true,
        headerName: 'x-api-key',
        apiKeys: ['key-a']
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('accepts hashed keys when provided', async () => {
    const token = 'hashed-key';
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const req = makeReq({ authorization: `Bearer ${token}` });
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: true,
        headerName: 'x-api-key',
        apiKeys: [],
        hashedKeys: [`sha256:${digest}`]
      } as any)
    ).resolves.toBe(token);
  });

  test('accepts hashed keys without prefix', async () => {
    const token = 'hashed-key-2';
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const req = makeReq({ authorization: `Bearer ${token}` });
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: true,
        apiKeys: [],
        hashedKeys: [digest]
      } as any)
    ).resolves.toBe(token);
  });

  test('rejects invalid credentials with 401', async () => {
    const req = makeReq({ authorization: 'Bearer longer-token' });
    await expect(
      assertAuthorized(req, {
        enabled: true,
        allowBearer: true,
        apiKeys: ['short'] // mismatched length exercises safeEqual mismatch branch
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('authorize callback can forbid', async () => {
    const req = makeReq({ authorization: 'Bearer key-1' });
    await expect(
      assertAuthorized(
        req,
        { enabled: true, allowBearer: true, apiKeys: ['key-1'] } as any,
        async () => false
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'forbidden' });
  });

  test('defaults allowBearer/allowApiKeyHeader to true', async () => {
    const req = makeReq({ authorization: 'Bearer key-1' });
    await expect(
      assertAuthorized(req, { enabled: true, apiKeys: ['key-1'] } as any)
    ).resolves.toBe('key-1');
  });

  test('handles req with no headers object', async () => {
    const req: any = { socket: { remoteAddress: '127.0.0.1' } };
    await expect(
      assertAuthorized(req, { enabled: true, apiKeys: ['key-1'] } as any)
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test('normalizeKeyList parses comma-separated string', () => {
    expect(normalizeKeyList('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(normalizeKeyList(['x', 'y'])).toEqual(['x', 'y']);
  });
});
