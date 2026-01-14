import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getExtensionPluginRoots,
  resetExtensionPluginRootsCache
} from '@/modules/extensions/index.ts';

describe('modules/extensions/extension-paths', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetExtensionPluginRootsCache();
  });

  afterEach(() => {
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
    resetExtensionPluginRootsCache();
  });

  describe('getExtensionPluginRoots', () => {
    test('returns array with single root when plugins dir exists only at packageRoot', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const pluginsDir = path.join(tempRoot, 'extensions', 'test-ext', 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const result = getExtensionPluginRoots('test-ext', { packageRoot: tempRoot });

        expect(result).toEqual([pluginsDir]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test('returns array with single root when plugins dir exists only at cwd', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd-'));
      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      try {
        const cwdPluginsDir = path.join(tempCwd, 'extensions', 'test-ext', 'plugins');
        fs.mkdirSync(cwdPluginsDir, { recursive: true });

        process.chdir(tempCwd);

        const result = getExtensionPluginRoots('test-ext', { packageRoot: tempPackageRoot });

        expect(result).toEqual([cwdPluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    });

    test('returns multiple roots in priority order when plugins exist in both packageRoot and cwd', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-multi-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-multi-cwd-'));
      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      try {
        const pkgPluginsDir = path.join(tempPackageRoot, 'extensions', 'both-ext', 'plugins');
        fs.mkdirSync(pkgPluginsDir, { recursive: true });

        const cwdPluginsDir = path.join(tempCwd, 'extensions', 'both-ext', 'plugins');
        fs.mkdirSync(cwdPluginsDir, { recursive: true });

        process.chdir(tempCwd);

        const result = getExtensionPluginRoots('both-ext', { packageRoot: tempPackageRoot });

        // packageRoot comes before cwd in priority order
        expect(result).toEqual([pkgPluginsDir, cwdPluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    });

    test('returns empty array when no plugins dir found anywhere', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-empty-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-empty-cwd-'));
      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      try {
        process.chdir(tempCwd);

        const result = getExtensionPluginRoots('nonexistent-ext', { packageRoot: tempPackageRoot });

        expect(result).toEqual([]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    });

    test('caches results for subsequent calls with same extensionId', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cache-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const pluginsDir = path.join(tempRoot, 'extensions', 'cached-ext', 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const result1 = getExtensionPluginRoots('cached-ext', { packageRoot: tempRoot });

        // Delete the directory to prove cache is used
        fs.rmSync(tempRoot, { recursive: true, force: true });

        const result2 = getExtensionPluginRoots('cached-ext', { packageRoot: tempRoot });

        expect(result1).toBe(result2); // Same array reference
        expect(result2).toEqual([pluginsDir]);
      } finally {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch {}
      }
    });

    test('caches different extensions independently', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-multi-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const ext1Plugins = path.join(tempRoot, 'extensions', 'ext-one', 'plugins');
        fs.mkdirSync(ext1Plugins, { recursive: true });

        const ext2Plugins = path.join(tempRoot, 'extensions', 'ext-two', 'plugins');
        fs.mkdirSync(ext2Plugins, { recursive: true });

        const result1 = getExtensionPluginRoots('ext-one', { packageRoot: tempRoot });
        const result2 = getExtensionPluginRoots('ext-two', { packageRoot: tempRoot });

        expect(result1).toEqual([ext1Plugins]);
        expect(result2).toEqual([ext2Plugins]);
        expect(result1).not.toBe(result2);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test('deduplicates paths when packageRoot and cwd are the same', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-dedup-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const pluginsDir = path.join(tempRoot, 'extensions', 'dedup-ext', 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        process.chdir(tempRoot);

        const result = getExtensionPluginRoots('dedup-ext', { packageRoot: tempRoot });

        // Should only appear once even though packageRoot === cwd
        expect(result).toEqual([pluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('resetExtensionPluginRootsCache', () => {
    test('clears cache and allows fresh resolution', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-reset-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const pluginsDir = path.join(tempRoot, 'extensions', 'reset-ext', 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const result1 = getExtensionPluginRoots('reset-ext', { packageRoot: tempRoot });
        expect(result1).toEqual([pluginsDir]);

        // Delete directory and verify cache still returns old result
        fs.rmSync(tempRoot, { recursive: true, force: true });
        const result2 = getExtensionPluginRoots('reset-ext', { packageRoot: tempRoot });
        expect(result2).toBe(result1); // Same cached array

        // Reset cache
        resetExtensionPluginRootsCache();

        // Now should resolve freshly (empty since dir is gone)
        const result3 = getExtensionPluginRoots('reset-ext', { packageRoot: tempRoot });
        expect(result3).not.toBe(result1); // New array
        expect(result3).toEqual([]); // Empty since plugins dir gone
      } finally {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch {}
      }
    });

    test('cache key includes packageRoot for proper isolation', () => {
      const rawTempRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-iso1-'));
      const rawTempRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-iso2-'));
      const tempRoot1 = fs.realpathSync(rawTempRoot1);
      const tempRoot2 = fs.realpathSync(rawTempRoot2);
      try {
        const plugins1Dir = path.join(tempRoot1, 'extensions', 'iso-ext', 'plugins');
        fs.mkdirSync(plugins1Dir, { recursive: true });

        const plugins2Dir = path.join(tempRoot2, 'extensions', 'iso-ext', 'plugins');
        fs.mkdirSync(plugins2Dir, { recursive: true });

        const result1 = getExtensionPluginRoots('iso-ext', { packageRoot: tempRoot1 });
        const result2 = getExtensionPluginRoots('iso-ext', { packageRoot: tempRoot2 });

        expect(result1).toEqual([plugins1Dir]);
        expect(result2).toEqual([plugins2Dir]);
        expect(result1).not.toBe(result2);
      } finally {
        fs.rmSync(tempRoot1, { recursive: true, force: true });
        fs.rmSync(tempRoot2, { recursive: true, force: true });
      }
    });
  });

  describe('integration with real PACKAGE_ROOT', () => {
    test('returns roots for voice extension using default PACKAGE_ROOT', () => {
      const result = getExtensionPluginRoots('voice');

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('plugins');

      // The first plugins directory should actually exist
      expect(fs.existsSync(result[0])).toBe(true);
    });
  });

  describe('cwd-aware cache invalidation', () => {
    test('invalidates cache when cwd changes', () => {
      const tempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd-inv-'));
      const tempCwd1 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd1-'));
      const tempCwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd2-'));
      const canonicalCwd1 = fs.realpathSync(tempCwd1);
      const canonicalCwd2 = fs.realpathSync(tempCwd2);
      const canonicalPkgRoot = fs.realpathSync(tempPackageRoot);

      try {
        // Create extension only in cwd1
        const cwd1PluginsDir = path.join(canonicalCwd1, 'extensions', 'cwd-test-ext', 'plugins');
        fs.mkdirSync(cwd1PluginsDir, { recursive: true });

        // Create extension only in cwd2
        const cwd2PluginsDir = path.join(canonicalCwd2, 'extensions', 'cwd-test-ext', 'plugins');
        fs.mkdirSync(cwd2PluginsDir, { recursive: true });

        // Get roots from cwd1
        process.chdir(canonicalCwd1);
        const result1 = getExtensionPluginRoots('cwd-test-ext', { packageRoot: canonicalPkgRoot });
        expect(result1).toEqual([cwd1PluginsDir]);

        // Change to cwd2 - cache should invalidate
        process.chdir(canonicalCwd2);
        const result2 = getExtensionPluginRoots('cwd-test-ext', { packageRoot: canonicalPkgRoot });

        // Should resolve to cwd2's extension, not return cached cwd1 result
        expect(result2).toEqual([cwd2PluginsDir]);
        expect(result2).not.toBe(result1); // Different array due to cache invalidation
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd1, { recursive: true, force: true });
        fs.rmSync(tempCwd2, { recursive: true, force: true });
      }
    });

    test('maintains cache when cwd does not change', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd-stable-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const pluginsDir = path.join(tempRoot, 'extensions', 'stable-ext', 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        process.chdir(tempRoot);

        const result1 = getExtensionPluginRoots('stable-ext', { packageRoot: tempRoot });
        const result2 = getExtensionPluginRoots('stable-ext', { packageRoot: tempRoot });

        expect(result1).toBe(result2); // Same array reference (cached)
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('path canonicalization with realpathSync', () => {
    test('returns canonicalized paths for existing directories', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-canon-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        const pluginsDir = path.join(tempRoot, 'extensions', 'canon-ext', 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const result = getExtensionPluginRoots('canon-ext', { packageRoot: tempRoot });

        // Paths should be canonical (equal to realpathSync result)
        expect(result[0]).toBe(fs.realpathSync(pluginsDir));
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('external roots from adapter paths config', () => {
    test('resolves extension from external root when configured', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extroot-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extroot-cwd-'));
      const rawTempExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extroot-ext-'));

      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      const tempExternalRoot = fs.realpathSync(rawTempExternalRoot);

      try {
        // Create extension ONLY in external root
        const externalPluginsDir = path.join(tempExternalRoot, 'external-ext', 'plugins');
        fs.mkdirSync(externalPluginsDir, { recursive: true });

        // Create llm-adapter.paths.json in tempCwd pointing to external root
        const pathsConfig = {
          paths: {
            lookup: {
              extensions: {
                builtin: true,
                externalRoots: [tempExternalRoot]
              }
            }
          }
        };
        fs.writeFileSync(
          path.join(tempCwd, 'llm-adapter.paths.json'),
          JSON.stringify(pathsConfig, null, 2)
        );

        process.chdir(tempCwd);
        resetExtensionPluginRootsCache();

        const result = getExtensionPluginRoots('external-ext', { packageRoot: tempPackageRoot });

        expect(result).toEqual([externalPluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
        fs.rmSync(tempExternalRoot, { recursive: true, force: true });
      }
    });

    test('returns external root before packageRoot in priority order', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extpref-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extpref-cwd-'));
      const rawTempExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extpref-ext-'));

      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      const tempExternalRoot = fs.realpathSync(rawTempExternalRoot);

      try {
        // Create extension in BOTH external root and packageRoot
        const externalPluginsDir = path.join(tempExternalRoot, 'prefer-ext', 'plugins');
        fs.mkdirSync(externalPluginsDir, { recursive: true });

        const pkgPluginsDir = path.join(tempPackageRoot, 'extensions', 'prefer-ext', 'plugins');
        fs.mkdirSync(pkgPluginsDir, { recursive: true });

        // Create llm-adapter.paths.json
        const pathsConfig = {
          paths: {
            lookup: {
              extensions: {
                builtin: true,
                externalRoots: [tempExternalRoot]
              }
            }
          }
        };
        fs.writeFileSync(
          path.join(tempCwd, 'llm-adapter.paths.json'),
          JSON.stringify(pathsConfig, null, 2)
        );

        process.chdir(tempCwd);
        resetExtensionPluginRootsCache();

        const result = getExtensionPluginRoots('prefer-ext', { packageRoot: tempPackageRoot });

        // External root should come first (highest priority)
        expect(result).toEqual([externalPluginsDir, pkgPluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
        fs.rmSync(tempExternalRoot, { recursive: true, force: true });
      }
    });

    test('falls back to packageRoot when external root does not have extension', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extfall-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extfall-cwd-'));
      const rawTempExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extfall-ext-'));

      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      const tempExternalRoot = fs.realpathSync(rawTempExternalRoot);

      try {
        // Create extension ONLY in packageRoot (not in external root)
        const pkgPluginsDir = path.join(tempPackageRoot, 'extensions', 'fallback-ext', 'plugins');
        fs.mkdirSync(pkgPluginsDir, { recursive: true });

        // Create llm-adapter.paths.json with external root (but no extension there)
        const pathsConfig = {
          paths: {
            lookup: {
              extensions: {
                builtin: true,
                externalRoots: [tempExternalRoot]
              }
            }
          }
        };
        fs.writeFileSync(
          path.join(tempCwd, 'llm-adapter.paths.json'),
          JSON.stringify(pathsConfig, null, 2)
        );

        process.chdir(tempCwd);
        resetExtensionPluginRootsCache();

        const result = getExtensionPluginRoots('fallback-ext', { packageRoot: tempPackageRoot });

        // Should return packageRoot since external root doesn't have it
        expect(result).toEqual([pkgPluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
        fs.rmSync(tempExternalRoot, { recursive: true, force: true });
      }
    });

    test('returns all three roots when extension exists in external, packageRoot, and cwd', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-all-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-all-cwd-'));
      const rawTempExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-all-ext-'));

      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      const tempExternalRoot = fs.realpathSync(rawTempExternalRoot);

      try {
        // Create extension in all three locations
        const externalPluginsDir = path.join(tempExternalRoot, 'all-ext', 'plugins');
        fs.mkdirSync(externalPluginsDir, { recursive: true });

        const pkgPluginsDir = path.join(tempPackageRoot, 'extensions', 'all-ext', 'plugins');
        fs.mkdirSync(pkgPluginsDir, { recursive: true });

        const cwdPluginsDir = path.join(tempCwd, 'extensions', 'all-ext', 'plugins');
        fs.mkdirSync(cwdPluginsDir, { recursive: true });

        // Create llm-adapter.paths.json
        const pathsConfig = {
          paths: {
            lookup: {
              extensions: {
                builtin: true,
                externalRoots: [tempExternalRoot]
              }
            }
          }
        };
        fs.writeFileSync(
          path.join(tempCwd, 'llm-adapter.paths.json'),
          JSON.stringify(pathsConfig, null, 2)
        );

        process.chdir(tempCwd);
        resetExtensionPluginRootsCache();

        const result = getExtensionPluginRoots('all-ext', { packageRoot: tempPackageRoot });

        // All three in priority order: external > packageRoot > cwd
        expect(result).toEqual([externalPluginsDir, pkgPluginsDir, cwdPluginsDir]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
        fs.rmSync(tempExternalRoot, { recursive: true, force: true });
      }
    });
  });
});
