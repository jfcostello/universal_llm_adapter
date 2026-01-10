import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { ManifestError, PluginRegistry } from '@/kernel/index.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('core/registry (coverage)', () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(ROOT_DIR);
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('normalizes lookup config edge cases (pluginsPath, externalRoots, areas)', async () => {
    await withTempCwd('registry-coverage-normalize', async (cwd) => {
      const absPlugins = path.join(cwd, 'abs-plugins');
      fs.mkdirSync(absPlugins, { recursive: true });

      // Absolute pluginsPath should be used as-is (path.isAbsolute branch).
      writeJson(path.join(absPlugins, 'providers', 'p.json'), {
        id: 'p',
        compat: 'openai',
        endpoint: { urlTemplate: 'http://localhost', method: 'POST', headers: {} }
      });

      const absRegistry = new PluginRegistry({
        pluginsPath: absPlugins,
        lookup: { builtinManifests: false, builtinCode: false, local: true, externalRoots: [] }
      });
      await expect(absRegistry.getProvider('p')).resolves.toBeDefined();

      // pluginsPath omitted -> falls back to "./plugins" (?? branch).
      new PluginRegistry({ lookup: { builtinManifests: false, builtinCode: false, local: false, externalRoots: [] } });

      // pluginsPath whitespace -> falls back to "./plugins" (trim + || branch).
      new PluginRegistry({ pluginsPath: '   ', lookup: { builtinManifests: false, builtinCode: false, local: false, externalRoots: [] } });

      // lookup omitted -> uses defaults (externalRoots non-array branch).
      new PluginRegistry({ pluginsPath: './plugins' });

      // externalRoots: non-array and non-string entries are ignored; relative roots are resolved.
      const areaOverrideRegistry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [123, './rel-pack'] as any,
          areas: {
            // Invalid area entry should be ignored (continue branch).
            '': null as any,
            // Area overrides should accept boolean flags + externalRoots (including relative roots and non-strings).
            providers: {
              builtinManifests: true,
              builtinCode: false,
              local: false,
              externalRoots: ['./area-pack', 456] as any
            }
          }
        } as any
      });

      // Trigger getLookupAreaConfig override logic by loading builtin provider manifests via an area override.
      await expect(areaOverrideRegistry.getProvider('openai')).resolves.toBeDefined();
    });
  });

  test('covers legacy-only internal helpers (lookup fallback + pack roots)', () => {
    const pluginsDir = resolveFixture('plugins', 'basic');
    const legacy = new PluginRegistry(pluginsDir);

    // Private helpers are exercised directly for legacy-mode coverage.
    (legacy as any).getLookupAreaConfig('providers');
    (legacy as any).getPackRootsLowToHigh('providers', 'manifests');
  });

  test('includes builtin manifests and builtin code when enabled', async () => {
    await withTempCwd('registry-coverage-builtin', async () => {
      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: true,
          builtinCode: true,
          local: false,
          externalRoots: []
        }
      });

      await expect(registry.getProvider('openai')).resolves.toBeDefined();
      await expect(registry.getCompatModule('openai')).resolves.toBeDefined();
    });
  });

  test('covers multi-root code resolution fallbacks (missing dirs, missing modules, relative preferred root)', async () => {
    await withTempCwd('registry-coverage-code-resolve', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      // Provider manifest is in rootA, but rootA intentionally has no compat directory.
      writeJson(path.join(rootA, 'providers', 'p.json'), {
        id: 'p',
        compat: 'foo',
        endpoint: { urlTemplate: 'http://localhost', method: 'POST', headers: {} }
      });

      // Compat exists only in rootB.
      writeCjsClass(rootB, 'compat', 'foo', 'B');

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [rootA, rootB]
        }
      });

      const compat = await registry.getCompatModuleForProvider('p');
      expect((compat as any).__marker).toBe('B');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // No compat module found in any root -> resolvePluginCodeEntryMultiRoot returns undefined (winner missing path).
        await expect(registry.getCompatModule('definitely-missing')).rejects.toThrow(ManifestError);
      } finally {
        warnSpy.mockRestore();
      }

      // Explicitly exercise the "preferredPackRoot is relative" path normalization branch.
      const resolved = (registry as any).resolvePluginCodeEntryMultiRoot('compat', 'foo', './pack-b');
      expect(resolved).toBeDefined();
    });
  });
});

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function writeCjsClass(root: string, area: string, moduleName: string, marker: string): void {
  const filePath = path.join(root, area, moduleName, 'index.js');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `module.exports = class Compat { constructor() { this.__marker = ${JSON.stringify(marker)}; } }`,
    'utf-8'
  );
}
