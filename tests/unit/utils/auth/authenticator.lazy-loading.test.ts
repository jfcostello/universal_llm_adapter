import { jest } from '@jest/globals';

describe('utils/auth lazy loading', () => {
  test('mode=none does not eagerly import other authenticators', async () => {
    jest.resetModules();

    (jest as any).unstable_mockModule('../../../../modules/auth/internal/api-key.js', () => {
      throw new Error('api-key authenticator should not be imported for mode=none');
    });

    (jest as any).unstable_mockModule('../../../../modules/auth/internal/proxy-signed.js', () => {
      throw new Error('proxySigned authenticator should not be imported for mode=none');
    });

    const { createAuthenticator } = await import('@/modules/auth/index.ts');

    const authenticator = createAuthenticator({ mode: 'none' });
    const ctx = await authenticator.authenticate({ headers: {} } as any);
    expect(ctx).toEqual({ mode: 'none' });
  });
});

