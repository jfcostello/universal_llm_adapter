import crypto from 'crypto';
import { jest } from '@jest/globals';
import { SignJWT, importPKCS8 } from 'jose';

import { baseSpec, canBindToLocalhost, requestRaw, startServer } from './test-helpers.ts';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

function createOkCoordinator() {
  return {
    run: jest.fn().mockResolvedValue({ ok: true }),
    runStream: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined)
  };
}

function signProxySigned(options: {
  timestampSeconds: number;
  method: string;
  url: string;
  subject: string;
  tenant?: string;
  scopesRaw?: string;
  resolvedKeyId: string;
  secret: string;
}): string {
  const payload = [
    'llm-adapter-proxy-signed-v1',
    String(options.timestampSeconds),
    String(options.method).toUpperCase(),
    options.url,
    options.subject,
    options.tenant ?? '',
    options.scopesRaw ?? '',
    options.resolvedKeyId
  ].join('\n');
  return crypto.createHmac('sha256', options.secret).update(payload).digest('hex');
}

describe('utils/server (integration) auth modes', () => {
  test('jwt (spki): missing/invalid token returns 401; valid Bearer token returns 200', async () => {
    if (!networkAvailable) return;

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const spkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const signingKey = await importPKCS8(pkcs8Pem, 'RS256');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ tenant: 't1', scope: 'read write' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user_1')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 60)
      .sign(signingKey);

    const { server } = await startServer(
      {
        auth: { mode: 'jwt', spki: spkiPem, algorithms: ['RS256'], allowBearer: true }
      } as any,
      createOkCoordinator
    );

    try {
      const missing = await requestRaw(server.url, {
        method: 'POST',
        path: '/run',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseSpec)
      });
      expect(missing.status).toBe(401);
      expect(JSON.parse(missing.body).error.code).toBe('unauthorized');
      expect(String(missing.headers['www-authenticate'] ?? '')).toMatch(/Bearer/i);

      const invalid = await requestRaw(server.url, {
        method: 'POST',
        path: '/run',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not.a.jwt' },
        body: JSON.stringify(baseSpec)
      });
      expect(invalid.status).toBe(401);
      expect(JSON.parse(invalid.body).error.code).toBe('unauthorized');

      const ok = await requestRaw(server.url, {
        method: 'POST',
        path: '/run',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(baseSpec)
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 60_000);

  test('proxySigned: valid signature returns 200; single-key wrong keyId signature returns 401', async () => {
    if (!networkAvailable) return;

    const onlyKey = 'k1';
    const onlySecret = 's1';

    const { server } = await startServer(
      {
        auth: { mode: 'proxySigned', keys: [{ id: onlyKey, secret: onlySecret }] }
      } as any,
      createOkCoordinator
    );

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const signature = signProxySigned({
        timestampSeconds: nowSeconds,
        method: 'POST',
        url: '/run',
        subject: 'sub_1',
        resolvedKeyId: onlyKey,
        secret: onlySecret
      });

      const ok = await requestRaw(server.url, {
        method: 'POST',
        path: '/run',
        headers: {
          'Content-Type': 'application/json',
          'x-llm-adapter-signature': signature,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'sub_1'
        },
        body: JSON.stringify(baseSpec)
      });
      expect(ok.status).toBe(200);

      const badKeyId = 'evil_key';
      const signatureWrongKeyId = signProxySigned({
        timestampSeconds: nowSeconds,
        method: 'POST',
        url: '/run',
        subject: 'sub_1',
        resolvedKeyId: badKeyId,
        secret: onlySecret
      });

      const rejected = await requestRaw(server.url, {
        method: 'POST',
        path: '/run',
        headers: {
          'Content-Type': 'application/json',
          'x-llm-adapter-signature': signatureWrongKeyId,
          'x-llm-adapter-timestamp': String(nowSeconds),
          'x-llm-adapter-subject': 'sub_1',
          'x-llm-adapter-key-id': badKeyId
        },
        body: JSON.stringify(baseSpec)
      });
      expect(rejected.status).toBe(401);
      expect(JSON.parse(rejected.body).error.code).toBe('unauthorized');
    } finally {
      await server.close();
    }
  }, 60_000);
});

