import { jest } from '@jest/globals';
import { createServerHandlerWithDefaults } from '@/utils/server/index.ts';

describe('utils/server createServerHandlerWithDefaults', () => {
  test('throws when registry missing', () => {
    expect(() => createServerHandlerWithDefaults({})).toThrow('registry must be provided');
  });

  test('throws when called without options', () => {
    expect(() => createServerHandlerWithDefaults()).toThrow('registry must be provided');
  });

  test('returns a request handler when registry provided', () => {
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn() } as any
    });
    expect(typeof handler).toBe('function');
  });
});
