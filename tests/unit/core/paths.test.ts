import fs from 'fs';
import path from 'path';
import { PACKAGE_ROOT, findPackageRoot } from '@/kernel/internal/paths.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('kernel/internal/paths', () => {
  test('PACKAGE_ROOT resolves to a directory containing plugins/', () => {
    expect(PACKAGE_ROOT).toBeDefined();
    expect(typeof PACKAGE_ROOT).toBe('string');
    expect(fs.existsSync(PACKAGE_ROOT)).toBe(true);
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'plugins'))).toBe(true);
  });

  test('PACKAGE_ROOT contains package.json with name llm-adapter', () => {
    const pkgPath = path.join(PACKAGE_ROOT, 'package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.name).toBe('llm-adapter');
  });

  test('findPackageRoot returns startDir if plugins/ exists there', async () => {
    await withTempCwd('paths-plugins-exists', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'plugins'), { recursive: true });
      expect(findPackageRoot(cwd)).toBe(cwd);
    });
  });

  test('findPackageRoot walks up to find package.json with llm-adapter name and plugins/', async () => {
    await withTempCwd('paths-walk-up', async (cwd) => {
      // Create nested structure: cwd/deep/nested/start
      const startDir = path.join(cwd, 'deep', 'nested', 'start');
      fs.mkdirSync(startDir, { recursive: true });

      // Create package.json and plugins at cwd level
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'llm-adapter' }));
      fs.mkdirSync(path.join(cwd, 'plugins'), { recursive: true });

      // findPackageRoot should walk up from startDir and find cwd
      expect(findPackageRoot(startDir)).toBe(cwd);
    });
  });

  test('findPackageRoot returns startDir if no valid package root found', async () => {
    await withTempCwd('paths-no-valid-root', async (cwd) => {
      // Create nested structure with no plugins and wrong package name
      const startDir = path.join(cwd, 'deep', 'nested');
      fs.mkdirSync(startDir, { recursive: true });

      // Create package.json with wrong name (no plugins dir)
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'other-package' }));

      // findPackageRoot should return startDir as fallback
      expect(findPackageRoot(startDir)).toBe(startDir);
    });
  });

  test('findPackageRoot handles invalid package.json gracefully', async () => {
    await withTempCwd('paths-invalid-pkg', async (cwd) => {
      const startDir = path.join(cwd, 'nested');
      fs.mkdirSync(startDir, { recursive: true });

      // Create invalid package.json
      fs.writeFileSync(path.join(cwd, 'package.json'), 'not valid json {{{');

      // Should not throw, returns startDir as fallback
      expect(findPackageRoot(startDir)).toBe(startDir);
    });
  });
});
