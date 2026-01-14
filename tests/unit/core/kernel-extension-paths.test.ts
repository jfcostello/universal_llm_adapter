import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

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
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-'));
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
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-cache-'));
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
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-multi-'));
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
      const tempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-fallback-'));
      const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-fallback-cwd-'));
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
      const tempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-prefer-'));
      const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-prefer-cwd-'));
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
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-reset-'));
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
      const tempRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-iso1-'));
      const tempRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ext-paths-iso2-'));
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
});
