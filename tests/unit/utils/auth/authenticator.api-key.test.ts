import crypto from 'crypto';
import { describe, expect, test } from '@jest/globals';
import { createAuthenticator } from '@/modules/auth/index.ts';

function makeReq(headers: Record<string, string> = {}): any {
  return { headers };
}

describe('utils/auth (apiKey mode)', () => {
  test('throws on unsupported auth mode', () => {
    expect(() => createAuthenticator({ mode: 'nope' } as any)).toThrow(
      'Unsupported auth mode'
    );
  });

  test('mode:none allows all requests', async () => {
    const auth = createAuthenticator({ mode: 'none' });
    await expect(auth.authenticate(makeReq())).resolves.toMatchObject({ mode: 'none' });
  });

  test('throws when apiKey keys list is empty', () => {
    expect(() =>
      createAuthenticator({ mode: 'apiKey', keys: [] } as any)
    ).toThrow('at least one key');
  });

  test('throws when apiKey keys is not an array', () => {
    expect(() =>
      createAuthenticator({ mode: 'apiKey', keys: 'nope' } as any)
    ).toThrow('at least one key');
  });

  test('throws when apiKey key entry is missing', () => {
    expect(() =>
      createAuthenticator({
        mode: 'apiKey',
        keys: [undefined]
      } as any)
    ).toThrow('id is required');
  });

  test('throws when apiKey key id is missing', () => {
    expect(() =>
      createAuthenticator({
        mode: 'apiKey',
        keys: [{ id: '', token: 'key-a' }]
      } as any)
    ).toThrow('id is required');
  });

  test('throws when apiKey key token is missing', () => {
    expect(() =>
      createAuthenticator({
        mode: 'apiKey',
        keys: [{ id: 'svc-a', token: '' }]
      } as any)
    ).toThrow('token or sha256 is required');
  });

  test('throws when apiKey key specifies both token and sha256', () => {
    expect(() =>
      createAuthenticator({
        mode: 'apiKey',
        keys: [{ id: 'svc-a', token: 'key-a', sha256: 'sha256:'.padEnd(71, '0') }]
      } as any)
    ).toThrow('exactly one of token or sha256');
  });

  test('throws when apiKey key sha256 is not a 64-char hex digest', () => {
    expect(() =>
      createAuthenticator({
        mode: 'apiKey',
        keys: [{ id: 'svc-a', sha256: 'sha256:not-hex' }]
      } as any)
    ).toThrow('sha256 must be 64 hex');
  });

  test('accepts sha256 digest keys', async () => {
    const sha256 = crypto.createHash('sha256').update('key-a').digest('hex');
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-a', sha256: `sha256:${sha256}` }]
    });

    await expect(
      auth.authenticate(makeReq({ authorization: 'Bearer key-a' }))
    ).resolves.toMatchObject({ mode: 'apiKey', subject: 'svc-a' });
  });

  test('accepts sha256 digest keys without prefix', async () => {
    const sha256 = crypto.createHash('sha256').update('key-b').digest('hex');
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-b', sha256 }]
    });

    await expect(
      auth.authenticate(makeReq({ authorization: 'Bearer key-b' }))
    ).resolves.toMatchObject({ mode: 'apiKey', subject: 'svc-b' });
  });

  test('throws when apiKey keys include duplicate digests', () => {
    expect(() =>
      createAuthenticator({
        mode: 'apiKey',
        keys: [
          { id: 'svc-a', token: 'same' },
          { id: 'svc-b', token: 'same' }
        ]
      } as any)
    ).toThrow('digest must be unique');
  });

  test('accepts Authorization: Bearer token by default', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(
      auth.authenticate(makeReq({ authorization: 'Bearer key-a' }))
    ).resolves.toMatchObject({ mode: 'apiKey', subject: 'svc-a' });
  });

  test('accepts custom headerName when enabled', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      allowBearer: false,
      headerName: 'x-custom-key',
      allowHeader: true,
      keys: [{ id: 'svc-b', token: 'key-b' }]
    });

    await expect(
      auth.authenticate(makeReq({ 'x-custom-key': 'key-b' }))
    ).resolves.toMatchObject({ mode: 'apiKey', subject: 'svc-b' });
  });

  test('rejects missing credentials with 401 + WWW-Authenticate', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      realm: 'test-realm',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(auth.authenticate(makeReq())).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized',
      headers: { 'WWW-Authenticate': expect.stringContaining('test-realm') }
    });
  });

  test('defaults realm when none provided', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(auth.authenticate(makeReq())).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized',
      headers: { 'WWW-Authenticate': expect.stringContaining('llm-adapter') }
    });
  });

  test('rejects invalid credentials with 401', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(
      auth.authenticate(makeReq({ authorization: 'Bearer wrong' }))
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('allowBearer=false rejects bearer even if key matches', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      allowBearer: false,
      allowHeader: true,
      headerName: 'x-api-key',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(
      auth.authenticate(makeReq({ authorization: 'Bearer key-a' }))
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('allowHeader=false ignores header credentials', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      allowBearer: false,
      allowHeader: false,
      headerName: 'x-api-key',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(
      auth.authenticate(makeReq({ 'x-api-key': 'key-a' }))
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('handles request with non-object headers', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(auth.authenticate({ headers: 'bad' } as any)).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });

  test('handles request with missing headers property', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(auth.authenticate({} as any)).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });

  test('ignores non-Bearer Authorization header schemes', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      allowBearer: true,
      allowHeader: false,
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(
      auth.authenticate(makeReq({ authorization: 'Basic abc' }))
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('treats empty header tokens as missing credentials', async () => {
    const auth = createAuthenticator({
      mode: 'apiKey',
      allowBearer: false,
      allowHeader: true,
      headerName: 'x-api-key',
      keys: [{ id: 'svc-a', token: 'key-a' }]
    });

    await expect(
      auth.authenticate(makeReq({ 'x-api-key': '   ' }))
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });
});
