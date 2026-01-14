import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getExtensionPaths,
  resetExtensionPathsCache,
  type ExtensionPaths
} from '@/kernel/index.ts';

describe('kernel/extension-paths', () => {
  // Store original cwd to restore after tests that change it
  const originalCwd = process.cwd();

  beforeEach(() => {
    // Always reset cache between tests to ensure isolation
    resetExtensionPathsCache();
  });

  afterEach(() => {
    // Restore original cwd if changed
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
    resetExtensionPathsCache();
  });

  describe('getExtensionPaths', () => {
    test('returns correct paths when plugins dir exists at packageRoot', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        // Create extension with plugins dir at "package root"
        const extDir = path.join(tempRoot, 'extensions', 'test-ext');
        const pluginsDir = path.join(extDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const result = getExtensionPaths('test-ext', { packageRoot: tempRoot });

        expect(result.extensionRoot).toBe(extDir);
        expect(result.pluginsRoot).toBe(pluginsDir);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test('falls back to cwd when packageRoot plugins dir does not exist', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd-'));
      // Resolve to real paths to handle macOS /var -> /private/var symlink
      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      try {
        // No plugins at packageRoot
        // Create plugins only at cwd location
        const cwdExtDir = path.join(tempCwd, 'extensions', 'test-ext');
        const cwdPluginsDir = path.join(cwdExtDir, 'plugins');
        fs.mkdirSync(cwdPluginsDir, { recursive: true });

        // Change to temp cwd
        process.chdir(tempCwd);

        const result = getExtensionPaths('test-ext', { packageRoot: tempPackageRoot });

        expect(result.extensionRoot).toBe(cwdExtDir);
        expect(result.pluginsRoot).toBe(cwdPluginsDir);
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
        // Create extension with plugins dir
        const extDir = path.join(tempRoot, 'extensions', 'cached-ext');
        const pluginsDir = path.join(extDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        // First call
        const result1 = getExtensionPaths('cached-ext', { packageRoot: tempRoot });

        // Delete the directory to prove cache is used
        fs.rmSync(tempRoot, { recursive: true, force: true });

        // Second call should return cached result even though directory is gone
        const result2 = getExtensionPaths('cached-ext', { packageRoot: tempRoot });

        expect(result1).toBe(result2); // Same object reference
        expect(result2.extensionRoot).toBe(extDir);
        expect(result2.pluginsRoot).toBe(pluginsDir);
      } finally {
        // Directory already removed in test, but ensure cleanup
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch {}
      }
    });

    test('caches different extensions independently', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-multi-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        // Create two extensions
        const ext1Dir = path.join(tempRoot, 'extensions', 'ext-one');
        const ext1Plugins = path.join(ext1Dir, 'plugins');
        fs.mkdirSync(ext1Plugins, { recursive: true });

        const ext2Dir = path.join(tempRoot, 'extensions', 'ext-two');
        const ext2Plugins = path.join(ext2Dir, 'plugins');
        fs.mkdirSync(ext2Plugins, { recursive: true });

        const result1 = getExtensionPaths('ext-one', { packageRoot: tempRoot });
        const result2 = getExtensionPaths('ext-two', { packageRoot: tempRoot });

        expect(result1.extensionRoot).toBe(ext1Dir);
        expect(result2.extensionRoot).toBe(ext2Dir);
        expect(result1).not.toBe(result2);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test('returns fallback path when no plugins dir found anywhere', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-fallback-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-fallback-cwd-'));
      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      try {
        // No extensions anywhere
        process.chdir(tempCwd);

        const result = getExtensionPaths('nonexistent-ext', { packageRoot: tempPackageRoot });

        // Should return packageRoot-based path as fallback
        expect(result.extensionRoot).toBe(path.join(tempPackageRoot, 'extensions', 'nonexistent-ext'));
        expect(result.pluginsRoot).toBe(path.join(tempPackageRoot, 'extensions', 'nonexistent-ext', 'plugins'));
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    });

    test('prefers packageRoot over cwd when both have plugins', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-prefer-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-prefer-cwd-'));
      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      try {
        // Create plugins at both locations
        const pkgExtDir = path.join(tempPackageRoot, 'extensions', 'both-ext');
        const pkgPluginsDir = path.join(pkgExtDir, 'plugins');
        fs.mkdirSync(pkgPluginsDir, { recursive: true });

        const cwdExtDir = path.join(tempCwd, 'extensions', 'both-ext');
        const cwdPluginsDir = path.join(cwdExtDir, 'plugins');
        fs.mkdirSync(cwdPluginsDir, { recursive: true });

        process.chdir(tempCwd);

        const result = getExtensionPaths('both-ext', { packageRoot: tempPackageRoot });

        // Should prefer packageRoot
        expect(result.extensionRoot).toBe(pkgExtDir);
        expect(result.pluginsRoot).toBe(pkgPluginsDir);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    });
  });

  describe('resetExtensionPathsCache', () => {
    test('clears cache and allows fresh resolution', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-reset-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        // Create extension
        const extDir = path.join(tempRoot, 'extensions', 'reset-ext');
        const pluginsDir = path.join(extDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        // First resolution
        const result1 = getExtensionPaths('reset-ext', { packageRoot: tempRoot });
        expect(result1.extensionRoot).toBe(extDir);

        // Delete directory and verify cache still returns old result
        fs.rmSync(tempRoot, { recursive: true, force: true });
        const result2 = getExtensionPaths('reset-ext', { packageRoot: tempRoot });
        expect(result2).toBe(result1); // Same cached object

        // Reset cache
        resetExtensionPathsCache();

        // Now should resolve freshly (fallback since dir is gone)
        const result3 = getExtensionPaths('reset-ext', { packageRoot: tempRoot });
        expect(result3).not.toBe(result1); // New object
        // Falls back to packageRoot path since plugins dir no longer exists
        expect(result3.extensionRoot).toBe(extDir);
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
        // Create extension in both locations
        const ext1Dir = path.join(tempRoot1, 'extensions', 'iso-ext');
        const plugins1Dir = path.join(ext1Dir, 'plugins');
        fs.mkdirSync(plugins1Dir, { recursive: true });

        const ext2Dir = path.join(tempRoot2, 'extensions', 'iso-ext');
        const plugins2Dir = path.join(ext2Dir, 'plugins');
        fs.mkdirSync(plugins2Dir, { recursive: true });

        // Same extensionId but different packageRoots should resolve independently
        const result1 = getExtensionPaths('iso-ext', { packageRoot: tempRoot1 });
        const result2 = getExtensionPaths('iso-ext', { packageRoot: tempRoot2 });

        expect(result1.extensionRoot).toBe(ext1Dir);
        expect(result2.extensionRoot).toBe(ext2Dir);
        expect(result1).not.toBe(result2);
      } finally {
        fs.rmSync(tempRoot1, { recursive: true, force: true });
        fs.rmSync(tempRoot2, { recursive: true, force: true });
      }
    });
  });

  describe('integration with real PACKAGE_ROOT', () => {
    test('returns paths for voice extension using default PACKAGE_ROOT', () => {
      // This test verifies the function works with the actual PACKAGE_ROOT
      // The voice extension plugins should exist in the source tree
      const result = getExtensionPaths('voice');

      expect(result.extensionRoot).toContain('extensions');
      expect(result.extensionRoot).toContain('voice');
      expect(result.pluginsRoot).toContain('plugins');

      // The plugins directory should actually exist
      expect(fs.existsSync(result.pluginsRoot)).toBe(true);
    });
  });

  describe('cwd-aware cache invalidation', () => {
    test('invalidates cache when cwd changes', () => {
      const tempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd-inv-'));
      const tempCwd1 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd1-'));
      const tempCwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cwd2-'));
      // Canonicalize for macOS symlink handling
      const canonicalCwd1 = fs.realpathSync(tempCwd1);
      const canonicalCwd2 = fs.realpathSync(tempCwd2);
      const canonicalPkgRoot = fs.realpathSync(tempPackageRoot);

      try {
        // Create extension in cwd1
        const cwd1ExtDir = path.join(canonicalCwd1, 'extensions', 'cwd-test-ext');
        const cwd1PluginsDir = path.join(cwd1ExtDir, 'plugins');
        fs.mkdirSync(cwd1PluginsDir, { recursive: true });

        // Create extension in cwd2
        const cwd2ExtDir = path.join(canonicalCwd2, 'extensions', 'cwd-test-ext');
        const cwd2PluginsDir = path.join(cwd2ExtDir, 'plugins');
        fs.mkdirSync(cwd2PluginsDir, { recursive: true });

        // Get paths from cwd1
        process.chdir(canonicalCwd1);
        const result1 = getExtensionPaths('cwd-test-ext', { packageRoot: canonicalPkgRoot });
        expect(result1.extensionRoot).toBe(cwd1ExtDir);

        // Change to cwd2 - cache should invalidate
        process.chdir(canonicalCwd2);
        const result2 = getExtensionPaths('cwd-test-ext', { packageRoot: canonicalPkgRoot });

        // Should resolve to cwd2's extension, not return cached cwd1 result
        expect(result2.extensionRoot).toBe(cwd2ExtDir);
        expect(result2).not.toBe(result1); // Different object due to cache invalidation
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
        // Create extension
        const extDir = path.join(tempRoot, 'extensions', 'stable-ext');
        const pluginsDir = path.join(extDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        process.chdir(tempRoot);

        // Multiple calls with same cwd should return cached result
        const result1 = getExtensionPaths('stable-ext', { packageRoot: tempRoot });
        const result2 = getExtensionPaths('stable-ext', { packageRoot: tempRoot });

        expect(result1).toBe(result2); // Same object reference (cached)
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
        const extDir = path.join(tempRoot, 'extensions', 'canon-ext');
        const pluginsDir = path.join(extDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });

        const result = getExtensionPaths('canon-ext', { packageRoot: tempRoot });

        // Paths should be canonical (equal to realpathSync result)
        expect(result.extensionRoot).toBe(fs.realpathSync(extDir));
        expect(result.pluginsRoot).toBe(fs.realpathSync(pluginsDir));
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test('handles non-existent paths gracefully in fallback', () => {
      const rawTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-noexist-'));
      const tempRoot = fs.realpathSync(rawTempRoot);
      try {
        // No extensions directory - should still return valid fallback paths
        const result = getExtensionPaths('noexist-ext', { packageRoot: tempRoot });

        // Should return packageRoot-based fallback paths (not canonicalized since they don't exist)
        expect(result.extensionRoot).toBe(path.join(tempRoot, 'extensions', 'noexist-ext'));
        expect(result.pluginsRoot).toBe(path.join(tempRoot, 'extensions', 'noexist-ext', 'plugins'));
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
        // Create extension ONLY in external root (not in packageRoot or cwd)
        const externalExtDir = path.join(tempExternalRoot, 'external-ext');
        const externalPluginsDir = path.join(externalExtDir, 'plugins');
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

        // Reset cache to pick up new paths config
        resetExtensionPathsCache();

        const result = getExtensionPaths('external-ext', { packageRoot: tempPackageRoot });

        // Should resolve to the external root location
        expect(result.extensionRoot).toBe(externalExtDir);
        expect(result.pluginsRoot).toBe(externalPluginsDir);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
        fs.rmSync(tempExternalRoot, { recursive: true, force: true });
      }
    });

    test('prefers external root over packageRoot when both have extension', () => {
      const rawTempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extpref-pkg-'));
      const rawTempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extpref-cwd-'));
      const rawTempExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-extpref-ext-'));

      const tempPackageRoot = fs.realpathSync(rawTempPackageRoot);
      const tempCwd = fs.realpathSync(rawTempCwd);
      const tempExternalRoot = fs.realpathSync(rawTempExternalRoot);

      try {
        // Create extension in BOTH external root and packageRoot
        const externalExtDir = path.join(tempExternalRoot, 'prefer-ext');
        const externalPluginsDir = path.join(externalExtDir, 'plugins');
        fs.mkdirSync(externalPluginsDir, { recursive: true });

        const pkgExtDir = path.join(tempPackageRoot, 'extensions', 'prefer-ext');
        const pkgPluginsDir = path.join(pkgExtDir, 'plugins');
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
        resetExtensionPathsCache();

        const result = getExtensionPaths('prefer-ext', { packageRoot: tempPackageRoot });

        // External root should be preferred (checked first)
        expect(result.extensionRoot).toBe(externalExtDir);
        expect(result.pluginsRoot).toBe(externalPluginsDir);
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
        const pkgExtDir = path.join(tempPackageRoot, 'extensions', 'fallback-ext');
        const pkgPluginsDir = path.join(pkgExtDir, 'plugins');
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
        resetExtensionPathsCache();

        const result = getExtensionPaths('fallback-ext', { packageRoot: tempPackageRoot });

        // Should fall back to packageRoot since external root doesn't have it
        expect(result.extensionRoot).toBe(pkgExtDir);
        expect(result.pluginsRoot).toBe(pkgPluginsDir);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempPackageRoot, { recursive: true, force: true });
        fs.rmSync(tempCwd, { recursive: true, force: true });
        fs.rmSync(tempExternalRoot, { recursive: true, force: true });
      }
    });
  });
});
