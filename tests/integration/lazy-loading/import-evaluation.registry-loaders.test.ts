import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (registry loaders)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not import registry loader modules on kernel/registry import', async () => {
    await jest.isolateModulesAsync(async () => {
      for (const modulePath of [
        '../../../kernel/internal/registry/internal/loaders/providers.js',
        '../../../kernel/internal/registry/internal/loaders/realtime-providers.js',
        '../../../kernel/internal/registry/internal/loaders/tools.js',
        '../../../kernel/internal/registry/internal/loaders/mcp.js',
        '../../../kernel/internal/registry/internal/loaders/vector.js',
        '../../../kernel/internal/registry/internal/loaders/processes.js',
        '../../../kernel/internal/registry/internal/loaders/embeddings.js',
        '../../../kernel/internal/registry/internal/loaders/observability-providers.js'
      ]) {
        jest.unstable_mockModule(modulePath, () => {
          throw new Error(`registry loader should not be imported during registry import: ${modulePath}`);
        });
      }

      const { PluginRegistry } = await import('@/kernel/index.ts');
      expect(typeof PluginRegistry).toBe('function');

      // Constructor with options avoids needing the plugins root to exist.
      const registry = new PluginRegistry({ pluginsPath: './plugins' } as any);
      expect(registry).toBeTruthy();
    });
  });

  test('imports the providers loader only when providers are requested', async () => {
    await jest.isolateModulesAsync(async () => {
      let providersLoaderCalled = false;

      jest.unstable_mockModule('../../../kernel/internal/registry/internal/loaders/providers.js', () => ({
        loadProvidersInternal: async (state: any) => {
          providersLoaderCalled = true;
          state.providersLoaded = true;
          state.providers.set('p', { id: 'p', compat: 'stub-compat', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } });
        }
      }));

      for (const modulePath of [
        '../../../kernel/internal/registry/internal/loaders/realtime-providers.js',
        '../../../kernel/internal/registry/internal/loaders/tools.js',
        '../../../kernel/internal/registry/internal/loaders/mcp.js',
        '../../../kernel/internal/registry/internal/loaders/vector.js',
        '../../../kernel/internal/registry/internal/loaders/processes.js',
        '../../../kernel/internal/registry/internal/loaders/embeddings.js',
        '../../../kernel/internal/registry/internal/loaders/observability-providers.js'
      ]) {
        jest.unstable_mockModule(modulePath, () => {
          throw new Error(`registry loader should not be imported for getProvider: ${modulePath}`);
        });
      }

      const { PluginRegistry } = await import('@/kernel/index.ts');
      const registry = new PluginRegistry({ pluginsPath: './plugins' } as any);

      const provider = await registry.getProvider('p');
      expect(provider.id).toBe('p');
      expect(providersLoaderCalled).toBe(true);
    });
  });
});
