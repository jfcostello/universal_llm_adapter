import { describe, expect, jest, test } from '@jest/globals';
import { SignJWT, exportJWK, exportSPKI, generateKeyPair } from 'jose';

import { createAuthenticator } from '@/modules/auth/index.ts';
import { startStubServer } from '@tests/helpers/http-server.ts';

function makeReq(headers: Record<string, string> = {}): any {
  return { headers };
}

async function mintJwt(options: {
  subject?: string;
  issuer?: string;
  audience?: string;
  expSeconds?: number;
  iatSeconds?: number;
  claims?: Record<string, unknown>;
}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: any = await exportJWK(publicKey);
  jwk.kid = 'kid-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  let jwt = new SignJWT(options.claims ?? {}).setProtectedHeader({ alg: 'RS256', kid: 'kid-1' });
  if (options.issuer) jwt = jwt.setIssuer(options.issuer);
  if (options.audience) jwt = jwt.setAudience(options.audience);
  if (options.subject) jwt = jwt.setSubject(options.subject);
  if (Number.isFinite(options.iatSeconds)) jwt = jwt.setIssuedAt(options.iatSeconds!);
  if (Number.isFinite(options.expSeconds)) jwt = jwt.setExpirationTime(options.expSeconds!);

  const token = await jwt.sign(privateKey);
  return { token, jwks: { keys: [jwk] } };
}

describe('utils/auth (jwt mode)', () => {
  test('throws when jwt mode is missing jwksUrl and jwks', () => {
    expect(() => createAuthenticator({ mode: 'jwt' } as any)).toThrow('jwksUrl, jwks, or spki');
  });

	  test('authenticates a bearer JWT with static SPKI PEM', async () => {
	    const nowSeconds = Math.floor(Date.now() / 1000);
	    const { publicKey, privateKey } = await generateKeyPair('RS256');
	    const spki = await exportSPKI(publicKey);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://issuer.example')
      .setAudience('audience-spki')
      .setSubject('user-spki')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3600)
      .sign(privateKey);

    const auth = createAuthenticator({
      mode: 'jwt',
      spki,
      issuer: 'https://issuer.example',
      audience: 'audience-spki',
      algorithms: ['RS256']
    } as any);

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
      mode: 'jwt',
	      subject: 'user-spki'
	    });
	  });

	  test('throws when jwt spki is configured without algorithms', async () => {
	    const { publicKey } = await generateKeyPair('RS256');
	    const spki = await exportSPKI(publicKey);

	    const auth = createAuthenticator({
	      mode: 'jwt',
	      spki,
	      issuer: 'https://issuer.example',
	      audience: 'audience-spki'
	    } as any);

	    await expect(auth.authenticate(makeReq({ authorization: 'Bearer test' }))).rejects.toThrow(
	      /spki requires algorithms/i
	    );
	  });

	  test('rejects a bearer JWT when token algorithm is not configured for spki', async () => {
	    const nowSeconds = Math.floor(Date.now() / 1000);
	    const { publicKey, privateKey } = await generateKeyPair('RS512');
	    const spki = await exportSPKI(publicKey);

	    const token = await new SignJWT({})
	      .setProtectedHeader({ alg: 'RS512' })
	      .setIssuer('https://issuer.example')
	      .setAudience('audience-spki')
	      .setSubject('user-spki-bad-alg')
	      .setIssuedAt(nowSeconds)
	      .setExpirationTime(nowSeconds + 3600)
	      .sign(privateKey);

	    const auth = createAuthenticator({
	      mode: 'jwt',
	      spki,
	      issuer: 'https://issuer.example',
	      audience: 'audience-spki',
	      algorithms: ['RS256']
	    } as any);

	    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
	      statusCode: 401,
	      code: 'unauthorized'
	    });
	  });

	  test('authenticates a bearer JWT with local JWKS and maps tenant + scopes', async () => {
	    const nowSeconds = Math.floor(Date.now() / 1000);
	    const { token, jwks } = await mintJwt({
	      subject: 'user-1',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600,
      claims: { tenant: 't-1', scope: 'read write' }
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      tenantClaim: 'tenant',
      scopesClaim: 'scope',
      scopesSeparator: ' ',
      algorithms: ['RS256']
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toEqual({
      mode: 'jwt',
      subject: 'user-1',
      tenant: 't-1',
      scopes: ['read', 'write']
    });
  });

  test('maps scopes from an array claim', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-1b',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600,
      claims: { scope: ['read', null, 'write'] }
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1'
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
      mode: 'jwt',
      subject: 'user-1b',
      scopes: ['read', 'write']
    });
  });

  test('omits scopes when scope claim is blank', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-1c',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600,
      claims: { scope: '   ' }
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1'
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toEqual({
      mode: 'jwt',
      subject: 'user-1c'
    });
  });

  test('omits scopes when scope array normalizes to empty', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-1d',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600,
      claims: { scope: [null, ' '] }
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1'
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toEqual({
      mode: 'jwt',
      subject: 'user-1d'
    });
  });

  test('supports allowHeader + headerName when allowBearer is disabled', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-2',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      allowBearer: false,
      allowHeader: true,
      headerName: 'x-jwt'
    });

    await expect(auth.authenticate(makeReq({ 'x-jwt': token }))).resolves.toMatchObject({
      mode: 'jwt',
      subject: 'user-2'
    });
  });

  test('rejects JWT when audience does not match', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-3',
      issuer: 'https://issuer.example',
      audience: 'audience-ok',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-wrong'
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });

  test('rejects missing credentials with 401 + WWW-Authenticate', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { jwks } = await mintJwt({
      subject: 'user-4',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      realm: 'jwt-realm',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1'
    });

    await expect(auth.authenticate(makeReq())).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized',
      headers: { 'WWW-Authenticate': expect.stringContaining('jwt-realm') }
    });
  });

  test('rejects JWT without subject when requireSubject=true', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      requireSubject: true
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });

  test('allows JWT without subject when requireSubject=false', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      requireSubject: false
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toEqual({
      mode: 'jwt'
    });
  });

  test('omits tenant when tenantClaim is configured but missing in the JWT', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-tenant-missing',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      tenantClaim: 'tenant'
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toEqual({
      mode: 'jwt',
      subject: 'user-tenant-missing'
    });
  });

  test('omits tenant when tenantClaim is configured but resolves to a blank string', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-tenant-empty',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600,
      claims: { tenant: ' ' }
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      tenantClaim: 'tenant'
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toEqual({
      mode: 'jwt',
      subject: 'user-tenant-empty'
    });
  });

  test('honors clockToleranceSeconds when validating exp', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-tolerance',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds - 60,
      expSeconds: nowSeconds - 1
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      clockToleranceSeconds: 10
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
      mode: 'jwt',
      subject: 'user-tolerance'
    });
  });

  test('rejects JWT without exp when requireExp=true', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-5',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      requireExp: true
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });

  test('allows JWT without exp when requireExp=false (no caching)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-6',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      claims: { scope: 123 }
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      requireExp: false
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
      mode: 'jwt',
      subject: 'user-6'
    });
  });

  test('dedupes in-flight verifications for the same token', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-7',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      cacheMaxEntries: 10
    });

    const req = makeReq({ authorization: `Bearer ${token}` });
    const p1 = auth.authenticate(req);
    const p2 = auth.authenticate(req);
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { mode: 'jwt', subject: 'user-7' },
      { mode: 'jwt', subject: 'user-7' }
    ]);
  });

  test('expires cached entries and re-validates (fails once token is expired)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expSeconds = nowSeconds + 2;
    const { token, jwks } = await mintJwt({
      subject: 'user-8',
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      iatSeconds: nowSeconds,
      expSeconds
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwks,
      issuer: 'https://issuer.example',
      audience: 'audience-1',
      clockToleranceSeconds: 0
    });

    const req = makeReq({ authorization: `Bearer ${token}` });
    await expect(auth.authenticate(req)).resolves.toMatchObject({ mode: 'jwt', subject: 'user-8' });
    await expect(auth.authenticate(req)).resolves.toMatchObject({ mode: 'jwt', subject: 'user-8' });

    const sleepMs = Math.max(0, expSeconds * 1000 - Date.now() + 50);
    await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    await expect(auth.authenticate(req)).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('authenticates using remote JWKS URL', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-9',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(jwks));
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote'
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-9'
      });
    } finally {
      await server.close();
    }
  });

  test('rejects remote JWKS URL with an unsupported protocol', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-remote-unsupported',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const auth = createAuthenticator({
      mode: 'jwt',
      jwksUrl: 'ftp://example.com/jwks',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      jwksTimeoutMs: 0,
      jwksCooldownMs: -1,
      jwksCacheMaxAgeMs: 0,
      jwksMaxBytes: 0
    });

    await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });

    // Ensure the local JWKS isn't referenced by accident.
    expect(jwks.keys.length).toBe(1);
  });

  test('rejects when remote JWKS endpoint returns non-200', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token } = await mintJwt({
      subject: 'user-remote-404',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const server = await startStubServer((req, res) => {
      res.statusCode = 404;
      res.end('nope');
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote'
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
        statusCode: 401,
        code: 'unauthorized'
      });
    } finally {
      await server.close();
    }
  });

  test('rejects when remote JWKS endpoint returns invalid JSON', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token } = await mintJwt({
      subject: 'user-remote-json',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{ nope');
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote'
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
        statusCode: 401,
        code: 'unauthorized'
      });
    } finally {
      await server.close();
    }
  });

  test('rejects when remote JWKS payload is missing keys', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token } = await mintJwt({
      subject: 'user-remote-keys',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ nope: true }));
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote'
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
        statusCode: 401,
        code: 'unauthorized'
      });
    } finally {
      await server.close();
    }
  });

  test('rejects when remote JWKS response exceeds max bytes', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token } = await mintJwt({
      subject: 'user-remote-bytes',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('x'.repeat(1000));
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote',
        jwksMaxBytes: 10
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
        statusCode: 401,
        code: 'unauthorized'
      });
    } finally {
      await server.close();
    }
  });

  test('rejects when remote JWKS request times out', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-remote-timeout',
      issuer: 'https://issuer.example',
      audience: 'audience-remote',
      iatSeconds: nowSeconds,
      expSeconds: nowSeconds + 3600
    });

    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        setTimeout(() => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(jwks));
        }, 200);
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote',
        jwksTimeoutMs: 10
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
        statusCode: 401,
        code: 'unauthorized'
      });
    } finally {
      await server.close();
    }
  });

  test('re-fetches when jwksCacheMaxAgeMs=0 and continues with last good keys on fetch failure', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token, jwks } = await mintJwt({
      subject: 'user-remote-cache-0',
      issuer: 'https://issuer.example',
      audience: 'audience-remote-cache-0',
      iatSeconds: nowSeconds,
      claims: { tenant: 't-1' }
    });

    let requestCount = 0;
    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        requestCount += 1;
        if (requestCount === 1) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(jwks));
          return;
        }
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote-cache-0',
        tenantClaim: 'tenant',
        requireExp: false,
        jwksCacheMaxAgeMs: 0
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-remote-cache-0',
        tenant: 't-1'
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-remote-cache-0'
      });

      expect(requestCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  test('refreshes remote JWKS when stale and keeps using the last good set if refresh fails', async () => {
    const { token, jwks } = await mintJwt({
      subject: 'user-remote-stale',
      issuer: 'https://issuer.example',
      audience: 'audience-remote-stale'
    });

    const spy = jest.spyOn(Date, 'now');
    const t0Ms = 1_700_000_000_000;
    spy.mockReturnValue(t0Ms);

    let requestCount = 0;
    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        requestCount += 1;
        if (requestCount <= 2) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(jwks));
          return;
        }
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote-stale',
        requireExp: false,
        jwksCacheMaxAgeMs: 1
      });

      // First request loads JWKS (requestCount=1).
      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-remote-stale'
      });
      expect(requestCount).toBe(1);

      // Still fresh => no re-fetch.
      spy.mockReturnValue(t0Ms);
      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-remote-stale'
      });
      expect(requestCount).toBe(1);

      // Stale => re-fetch (requestCount=2).
      spy.mockReturnValue(t0Ms + 2);
      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-remote-stale'
      });
      expect(requestCount).toBe(2);

      // Stale again => refresh fails (requestCount=3), but we keep using last good set.
      spy.mockReturnValue(t0Ms + 4);
      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-remote-stale'
      });
      expect(requestCount).toBe(3);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  test('shares a single initial JWKS fetch across concurrent verifications', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk: any = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const jwks = { keys: [jwk] };

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token1 = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
      .setIssuer('https://issuer.example')
      .setAudience('audience-remote-concurrency')
      .setSubject('user-a')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3600)
      .sign(privateKey);
    const token2 = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
      .setIssuer('https://issuer.example')
      .setAudience('audience-remote-concurrency')
      .setSubject('user-b')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3600)
      .sign(privateKey);

    let requestCount = 0;
    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        requestCount += 1;
        setTimeout(() => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(jwks));
        }, 50);
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote-concurrency'
      });

      const [a, b] = await Promise.all([
        auth.authenticate(makeReq({ authorization: `Bearer ${token1}` })),
        auth.authenticate(makeReq({ authorization: `Bearer ${token2}` }))
      ]);

      expect(a).toMatchObject({ mode: 'jwt', subject: 'user-a' });
      expect(b).toMatchObject({ mode: 'jwt', subject: 'user-b' });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  test('re-fetches JWKS on kid mismatch when jwksCooldownMs=0', async () => {
    const { publicKey: pub1 } = await generateKeyPair('RS256');
    const { publicKey: pub2, privateKey: priv2 } = await generateKeyPair('RS256');

    const jwk1: any = await exportJWK(pub1);
    jwk1.kid = 'kid-1';
    jwk1.alg = 'RS256';
    jwk1.use = 'sig';

    const jwk2: any = await exportJWK(pub2);
    jwk2.kid = 'kid-2';
    jwk2.alg = 'RS256';
    jwk2.use = 'sig';

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-2' })
      .setIssuer('https://issuer.example')
      .setAudience('audience-remote-kid-reload')
      .setSubject('user-kid-2')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3600)
      .sign(priv2);

    let requestCount = 0;
    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        requestCount += 1;
        const body = requestCount === 1 ? { keys: [jwk1] } : { keys: [jwk1, jwk2] };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote-kid-reload',
        jwksCooldownMs: 0
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).resolves.toMatchObject({
        mode: 'jwt',
        subject: 'user-kid-2'
      });
      expect(requestCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  test('does not re-fetch on kid mismatch when jwksCooldownMs>0', async () => {
    const { publicKey: pub1 } = await generateKeyPair('RS256');
    const { publicKey: pub2, privateKey: priv2 } = await generateKeyPair('RS256');

    const jwk1: any = await exportJWK(pub1);
    jwk1.kid = 'kid-1';
    jwk1.alg = 'RS256';
    jwk1.use = 'sig';

    const jwk2: any = await exportJWK(pub2);
    jwk2.kid = 'kid-2';
    jwk2.alg = 'RS256';
    jwk2.use = 'sig';

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-2' })
      .setIssuer('https://issuer.example')
      .setAudience('audience-remote-kid-cooldown')
      .setSubject('user-kid-2')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3600)
      .sign(priv2);

    let requestCount = 0;
    const server = await startStubServer((req, res) => {
      if (req.url === '/jwks') {
        requestCount += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [jwk1] }));
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });

    try {
      const auth = createAuthenticator({
        mode: 'jwt',
        jwksUrl: `${server.url}/jwks`,
        issuer: 'https://issuer.example',
        audience: 'audience-remote-kid-cooldown',
        jwksCooldownMs: 30000
      });

      await expect(auth.authenticate(makeReq({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({
        statusCode: 401,
        code: 'unauthorized'
      });
      expect(requestCount).toBe(1);

      // Ensure we generated the unused key to avoid unused variable lint issues under strict builds.
      expect(jwk2.kid).toBe('kid-2');
    } finally {
      await server.close();
    }
  });

  test('rejects when jwtVerify returns a non-object payload', async () => {
    jest.resetModules();

    (jest as any).unstable_mockModule('jose', () => ({
      createLocalJWKSet: () => ({}),
      createRemoteJWKSet: () => ({}),
      importSPKI: async () => ({}),
      jwtVerify: async () => ({ payload: 'nope' })
    }));

    const { createAuthenticator } = await import('@/modules/auth/index.ts');
    const auth = createAuthenticator({
      mode: 'jwt',
      jwks: { keys: [] },
      requireSubject: false,
      requireExp: false
    });

    await expect(auth.authenticate(makeReq({ authorization: 'Bearer x' }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized'
    });
  });
});
