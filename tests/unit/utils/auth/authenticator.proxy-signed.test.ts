import crypto from 'crypto';
import { describe, expect, test } from '@jest/globals';

import { createAuthenticator } from '@/modules/auth/index.ts';

function signProxy(options: {
  secret: string;
  timestampSeconds: number;
  method: string;
  url: string;
  subject: string;
  tenant?: string;
  scopes?: string;
  keyId: string;
}): string {
  const payload = [
    'llm-adapter-proxy-signed-v1',
    String(options.timestampSeconds),
    String(options.method).toUpperCase(),
    String(options.url),
    String(options.subject),
    String(options.tenant ?? ''),
    String(options.scopes ?? ''),
    String(options.keyId)
  ].join('\n');
  return crypto.createHmac('sha256', options.secret).update(payload).digest('hex');
}

describe('utils/auth (proxySigned mode)', () => {
  test('throws when keys list is empty', () => {
    expect(() =>
      createAuthenticator({ mode: 'proxySigned', keys: [] } as any)
    ).toThrow('at least one key');
  });

  test('throws when key id is missing', () => {
    expect(() =>
      createAuthenticator({ mode: 'proxySigned', keys: [{ id: '', secret: 's' }] } as any)
    ).toThrow('id is required');
  });

  test('throws when key id is undefined', () => {
    expect(() =>
      createAuthenticator({ mode: 'proxySigned', keys: [{ secret: 's' }] } as any)
    ).toThrow('id is required');
  });

  test('throws when key secret is missing', () => {
    expect(() =>
      createAuthenticator({ mode: 'proxySigned', keys: [{ id: 'k1', secret: '' }] } as any)
    ).toThrow('secret is required');
  });

  test('throws when key secret is undefined', () => {
    expect(() =>
      createAuthenticator({ mode: 'proxySigned', keys: [{ id: 'k1' }] } as any)
    ).toThrow('secret is required');
  });

  test('throws when key ids are duplicated', () => {
    expect(() =>
      createAuthenticator({
        mode: 'proxySigned',
        keys: [
          { id: 'k1', secret: 's1' },
          { id: 'k1', secret: 's2' }
        ]
      } as any)
    ).toThrow('id must be unique');
  });

  test('authenticates a signed request with a single key (no key id header required)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run?x=1',
      subject: 'user-1',
      tenant: 't-1',
      scopes: 'read write',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    const req: any = {
      method: 'POST',
      url: '/run?x=1',
      headers: {
        'x-llm-adapter-signature': sig,
        'x-llm-adapter-timestamp': String(nowSeconds),
        'x-llm-adapter-subject': 'user-1',
        'x-llm-adapter-tenant': 't-1',
        'x-llm-adapter-scopes': 'read write'
      }
    };

    await expect(auth.authenticate(req)).resolves.toEqual({
      mode: 'proxySigned',
      subject: 'user-1',
      tenant: 't-1',
      scopes: ['read', 'write']
    });
  });

  test('authenticates a signed request with a single key and explicit key id', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user-kid',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user-kid',
          'x-llm-adapter-key-id': 'k1'
        }
      } as any)
    ).resolves.toEqual({ mode: 'proxySigned', subject: 'user-kid' });
  });

  test('rejects when a single-key config receives a mismatched key id header (even if the signature is otherwise valid)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user-kid-mismatch',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user-kid-mismatch',
          'x-llm-adapter-key-id': 'k-unknown'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects a signed request with a single key and unknown key id', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user-kid-unknown',
      keyId: 'k-unknown'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user-kid-unknown',
          'x-llm-adapter-key-id': 'k-unknown'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when signature is missing', async () => {
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({ method: 'POST', url: '/run', headers: { 'x-llm-adapter-timestamp': '1', 'x-llm-adapter-subject': 'u' } } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when req is null/undefined', async () => {
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(auth.authenticate(null as any)).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when a required header is present but blank', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': '   ',
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when timestamp is not numeric', async () => {
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({ method: 'POST', url: '/run', headers: { 'x-llm-adapter-signature': 'x', 'x-llm-adapter-timestamp': 'nope', 'x-llm-adapter-subject': 'u' } } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when timestamp is outside maxSkewSeconds', async () => {
    const auth = createAuthenticator({
      mode: 'proxySigned',
      maxSkewSeconds: 0,
      keys: [{ id: 'k1', secret: 's1' }]
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds - 1,
      method: 'POST',
      url: '/run',
      subject: 'user',
      keyId: 'k1'
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds - 1),
          'x-llm-adapter-subject': 'user'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when request headers is not an object', async () => {
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(auth.authenticate({ method: 'POST', url: '/run', headers: 'nope' } as any)).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });

  test('supports header arrays and omits scopes when not provided', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user-arr',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': [sig],
          'x-llm-adapter-timestamp': [String(nowSeconds)],
          'x-llm-adapter-subject': ['user-arr']
        }
      } as any)
    ).resolves.toEqual({ mode: 'proxySigned', subject: 'user-arr' });
  });

  test('rejects when a required array header is present but blank', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': ['   '],
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('requires key id when multiple keys are configured', async () => {
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [
        { id: 'k1', secret: 's1' },
        { id: 'k2', secret: 's2' }
      ]
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user',
      keyId: 'k1'
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('rejects when key id is unknown in a multi-key configuration', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [
        { id: 'k1', secret: 's1' },
        { id: 'k2', secret: 's2' }
      ]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user',
          'x-llm-adapter-key-id': 'k3'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('authenticates using key id to select secret', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's2',
      timestampSeconds: nowSeconds,
      method: 'POST',
      url: '/run',
      subject: 'user',
      scopes: 'a b',
      keyId: 'k2'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [
        { id: 'k1', secret: 's1' },
        { id: 'k2', secret: 's2' }
      ]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user',
          'x-llm-adapter-key-id': 'k2',
          'x-llm-adapter-scopes': 'a b'
        }
      } as any)
    ).resolves.toEqual({
      mode: 'proxySigned',
      subject: 'user',
      scopes: ['a', 'b']
    });
  });

  test('supports custom header names and scopes separator', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'GET',
      url: '/health',
      subject: 'user',
      scopes: 'a|b',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      scopesSeparator: '|',
      headers: {
        signature: 'x-sig',
        timestamp: 'x-ts',
        subject: 'x-sub',
        scopes: 'x-scopes'
      },
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'GET',
        url: '/health',
        headers: { 'x-sig': sig, 'x-ts': String(nowSeconds), 'x-sub': 'user', 'x-scopes': 'a|b' }
      } as any)
    ).resolves.toEqual({ mode: 'proxySigned', subject: 'user', scopes: ['a', 'b'] });
  });

  test('omits scopes when scopes header is present but has no values', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: 'GET',
      url: '/health',
      subject: 'user',
      scopes: '|',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      scopesSeparator: '|',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'GET',
        url: '/health',
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user',
          'x-llm-adapter-scopes': '|'
        }
      } as any)
    ).resolves.toEqual({ mode: 'proxySigned', subject: 'user' });
  });

  test('defaults method and url when missing', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signProxy({
      secret: 's1',
      timestampSeconds: nowSeconds,
      method: '',
      url: '/',
      subject: 'user-defaults',
      keyId: 'k1'
    });

    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        headers: {
          'x-llm-adapter-signature': sig,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user-defaults'
        }
      } as any)
    ).resolves.toEqual({ mode: 'proxySigned', subject: 'user-defaults' });
  });

  test('rejects when signature does not match', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const auth = createAuthenticator({
      mode: 'proxySigned',
      keys: [{ id: 'k1', secret: 's1' }]
    });

    await expect(
      auth.authenticate({
        method: 'POST',
        url: '/run',
        headers: {
          'x-llm-adapter-signature': 'deadbeef',
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'user'
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });
});
