import crypto from 'crypto';
import { describe, expect, jest, test } from '@jest/globals';
import { createSignedWsToken, verifySignedWsToken } from '@/modules/security/index.ts';

type VerifyResult = ReturnType<typeof verifySignedWsToken<any>>;

function getErrorCode(result: VerifyResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makeToken(secret: string, payloadJson: string): string {
  const payloadB64 = base64UrlEncode(Buffer.from(payloadJson, 'utf-8'));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64UrlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

describe('utils/security/signed-ws-token', () => {
  test('creates and verifies a signed token (with expected binding)', () => {
    const token = createSignedWsToken({
      secret: 'secret',
      payload: { iat: 100, exp: 200, nonce: 'n-1', sub: 'user-123' }
    });

    const verified = verifySignedWsToken({
      token,
      secret: 'secret',
      nowSeconds: 150,
      expected: { sub: 'user-123' }
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('expected ok');
    expect(verified.payload.sub).toBe('user-123');
  });

  test('verifySignedWsToken uses system clock when nowSeconds is not provided', () => {
    jest.useFakeTimers().setSystemTime(new Date('1970-01-01T00:02:30.000Z'));
    try {
      const token = createSignedWsToken({
        secret: 'secret',
        payload: { iat: 100, exp: 200, nonce: 'n-2', tag: 't' }
      });

      const verified = verifySignedWsToken({ token, secret: 'secret' });
      expect(verified.ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('createSignedWsToken validates inputs', () => {
    expect(() => createSignedWsToken({ secret: '', payload: { iat: 1, exp: 2, nonce: 'n' } })).toThrow('Missing secret');
    expect(() => createSignedWsToken({ secret: undefined as any, payload: { iat: 1, exp: 2, nonce: 'n' } })).toThrow('Missing secret');
    expect(() => createSignedWsToken({ secret: 'secret', payload: null as any })).toThrow('Invalid payload');

    expect(() => createSignedWsToken({ secret: 'secret', payload: { iat: Number.NaN, exp: 2, nonce: 'n' } as any })).toThrow(
      'Payload must include iat, exp, nonce'
    );
    expect(() => createSignedWsToken({ secret: 'secret', payload: { iat: 1, exp: Number.NaN, nonce: 'n' } as any })).toThrow(
      'Payload must include iat, exp, nonce'
    );
    expect(() => createSignedWsToken({ secret: 'secret', payload: { iat: 1, exp: 2, nonce: 123 } as any })).toThrow(
      'Payload must include iat, exp, nonce'
    );
    expect(() => createSignedWsToken({ secret: 'secret', payload: { iat: 1, exp: 2, nonce: '' } as any })).toThrow(
      'Payload must include iat, exp, nonce'
    );
  });

  test('verifySignedWsToken validates token and signature format', () => {
    expect(verifySignedWsToken({ token: ' ', secret: 'secret' })).toEqual({
      ok: false,
      error: { code: 'missing_token', message: 'Missing token' }
    });

    expect(verifySignedWsToken({ token: undefined as any, secret: 'secret' })).toEqual({
      ok: false,
      error: { code: 'missing_token', message: 'Missing token' }
    });

    expect(verifySignedWsToken({ token: 'a.b', secret: '' })).toEqual({
      ok: false,
      error: { code: 'missing_secret', message: 'Missing secret' }
    });

    expect(verifySignedWsToken({ token: 'a.b', secret: undefined as any })).toEqual({
      ok: false,
      error: { code: 'missing_secret', message: 'Missing secret' }
    });

    expect(verifySignedWsToken({ token: 'a.b.c', secret: 'secret' }).ok).toBe(false);
    expect(verifySignedWsToken({ token: '.b', secret: 'secret' }).ok).toBe(false);
    expect(verifySignedWsToken({ token: 'a.', secret: 'secret' }).ok).toBe(false);

    // payload invalid base64url
    expect(verifySignedWsToken({ token: 'ab+cd.ef', secret: 'secret' }).ok).toBe(false);
    // signature invalid base64url (payload is base64url)
    expect(verifySignedWsToken({ token: 'abcd.b*d', secret: 'secret' }).ok).toBe(false);

    const good = createSignedWsToken({
      secret: 'secret',
      payload: { iat: 100, exp: 200, nonce: 'n-3' }
    });
    const [goodPayloadB64, goodSigB64] = good.split('.');

    // same-length signature mismatch
    const flippedSig = goodSigB64.slice(0, -1) + (goodSigB64.endsWith('a') ? 'b' : 'a');
    expect(getErrorCode(verifySignedWsToken({ token: `${goodPayloadB64}.${flippedSig}`, secret: 'secret', nowSeconds: 150 }))).toBe(
      'invalid_signature'
    );

    // different-length signature mismatch (exercises length-mismatch timing guard)
    expect(getErrorCode(verifySignedWsToken({ token: `${goodPayloadB64}.a`, secret: 'secret', nowSeconds: 150 }))).toBe(
      'invalid_signature'
    );
  });

  test('verifySignedWsToken rejects malformed payloads even with a valid signature', () => {
    const badJsonToken = makeToken('secret', '{not-json');
    expect(getErrorCode(verifySignedWsToken({ token: badJsonToken, secret: 'secret', nowSeconds: 150 }))).toBe('invalid_payload');

    const nonObjectToken = makeToken('secret', '"hello"');
    expect(getErrorCode(verifySignedWsToken({ token: nonObjectToken, secret: 'secret', nowSeconds: 150 }))).toBe('invalid_payload');
  });

  test('verifySignedWsToken rejects missing required fields', () => {
    const badIat = makeToken('secret', JSON.stringify({ iat: 'x', exp: 200, nonce: 'n' }));
    expect(getErrorCode(verifySignedWsToken({ token: badIat, secret: 'secret', nowSeconds: 150 }))).toBe('missing_fields');

    const badExp = makeToken('secret', JSON.stringify({ iat: 100, exp: 'x', nonce: 'n' }));
    expect(getErrorCode(verifySignedWsToken({ token: badExp, secret: 'secret', nowSeconds: 150 }))).toBe('missing_fields');

    const badNonceType = makeToken('secret', JSON.stringify({ iat: 100, exp: 200, nonce: 1 }));
    expect(getErrorCode(verifySignedWsToken({ token: badNonceType, secret: 'secret', nowSeconds: 150 }))).toBe('missing_fields');

    const badNonceEmpty = makeToken('secret', JSON.stringify({ iat: 100, exp: 200, nonce: '' }));
    expect(getErrorCode(verifySignedWsToken({ token: badNonceEmpty, secret: 'secret', nowSeconds: 150 }))).toBe('missing_fields');
  });

  test('verifySignedWsToken enforces time bounds and ttl', () => {
    const futureIat = makeToken('secret', JSON.stringify({ iat: 200, exp: 300, nonce: 'n' }));
    expect(
      getErrorCode(verifySignedWsToken({ token: futureIat, secret: 'secret', nowSeconds: 100, clockSkewSeconds: 0 }))
    ).toBe('not_yet_valid');

    const expired = makeToken('secret', JSON.stringify({ iat: 100, exp: 110, nonce: 'n' }));
    expect(getErrorCode(verifySignedWsToken({ token: expired, secret: 'secret', nowSeconds: 200, clockSkewSeconds: 0 }))).toBe(
      'expired'
    );

    const invalidTtl = makeToken('secret', JSON.stringify({ iat: 100, exp: 100, nonce: 'n' }));
    expect(getErrorCode(verifySignedWsToken({ token: invalidTtl, secret: 'secret', nowSeconds: 100, clockSkewSeconds: 0 }))).toBe(
      'invalid_ttl'
    );

    const ttlTooLong = makeToken('secret', JSON.stringify({ iat: 100, exp: 1000, nonce: 'n' }));
    expect(getErrorCode(verifySignedWsToken({ token: ttlTooLong, secret: 'secret', nowSeconds: 150, maxTtlSeconds: 300 }))).toBe(
      'ttl_too_long'
    );
  });

  test('verifySignedWsToken rejects binding mismatches and sanitizes invalid options', () => {
    const token = makeToken('secret', JSON.stringify({ iat: 100, exp: 200, nonce: 'n', sessionId: 's-1' }));
    expect(getErrorCode(verifySignedWsToken({
      token,
      secret: 'secret',
      nowSeconds: 150,
      clockSkewSeconds: Number.NaN,
      maxTtlSeconds: Number.NaN,
      expected: { sessionId: 'different' }
    }))).toBe('binding_mismatch');
  });
});
