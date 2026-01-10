import { jest } from '@jest/globals';

describe('modules/realtime/internal/create-session (compat selection)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('uses getRealtimeCompatForProvider when available and falls back to spec.provider when provider.id is missing', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/realtime/internal/realtime-session.js', () => ({
        createRealtimeSessionController: () => ({
          sendText: async () => {},
          injectContext: async () => {},
          sendDTMF: async () => {},
          sendAudio: async () => {},
          commit: async () => {},
          interrupt: async () => {},
          close: async () => {},
          events: async function* () {}
        })
      }));

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const compat = { createSession: jest.fn().mockResolvedValue({}) };
      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ compat: 'rt' }),
        getRealtimeCompatForProvider: jest.fn().mockResolvedValue(compat),
        getRealtimeCompat: jest.fn(),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      await expect(createRealtimeSession(registry as any, { provider: 'p' } as any)).resolves.toBeDefined();

      expect(registry.getRealtimeCompatForProvider).toHaveBeenCalledWith('p');
      expect(registry.getRealtimeCompat).not.toHaveBeenCalled();
    });
  });
});
