import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

import { normalizeExternalRoots, resolveModuleEntryInRoot } from '@/kernel/index.ts';

describe('kernel/fs utils', () => {
  describe('resolveModuleEntryInRoot', () => {
    test('prefers <root>/<name>/index.js over single-file module', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-module-entry-'));
      try {
        fs.mkdirSync(path.join(root, 'foo'), { recursive: true });
        fs.writeFileSync(path.join(root, 'foo', 'index.js'), 'export default {}', 'utf-8');
        fs.writeFileSync(path.join(root, 'foo.js'), 'export default {}', 'utf-8');

        expect(resolveModuleEntryInRoot(root, 'foo')).toBe(path.join(root, 'foo', 'index.js'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('falls back to <root>/<name>.ts when no index.(js|ts) exists', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-module-entry-'));
      try {
        fs.writeFileSync(path.join(root, 'bar.ts'), 'export default {}', 'utf-8');

        expect(resolveModuleEntryInRoot(root, 'bar')).toBe(path.join(root, 'bar.ts'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('returns undefined when no entry exists', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-module-entry-'));
      try {
        expect(resolveModuleEntryInRoot(root, 'nope')).toBeUndefined();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('normalizeExternalRoots', () => {
    test('dedupes, trims, and resolves relative roots against cwd', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-'));
      try {
        const roots = normalizeExternalRoots(cwd, ['  ./a  ', './a', '../b', '', 123]);
        expect(roots).toEqual([
          path.resolve(cwd, './a'),
          path.resolve(cwd, '../b')
        ]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('dedupes roots that resolve to the same realpath', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-realpath-'));
      try {
        const target = path.join(cwd, 'target');
        const link = path.join(cwd, 'link');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, link, 'dir');

        const roots = normalizeExternalRoots(cwd, [target, link]);
        expect(roots).toEqual([fs.realpathSync(target)]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('warns when path does not exist', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-warn-'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const nonExistent = path.join(cwd, 'does-not-exist');
        const roots = normalizeExternalRoots(cwd, [nonExistent]);

        expect(roots).toEqual([nonExistent]);
        expect(warnSpy).toHaveBeenCalledWith(
          'external_roots.path_resolution_warning',
          expect.objectContaining({ path: nonExistent, warning: 'path does not exist' })
        );
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('warns when broken symlink cannot be resolved', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-broken-'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const brokenLink = path.join(cwd, 'broken-link');
        fs.symlinkSync(path.join(cwd, 'nonexistent-target'), brokenLink, 'dir');

        const roots = normalizeExternalRoots(cwd, [brokenLink]);

        expect(roots).toEqual([brokenLink]);
        expect(warnSpy).toHaveBeenCalledWith(
          'external_roots.path_resolution_warning',
          expect.objectContaining({ path: brokenLink, warning: 'path does not exist' })
        );
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('warns when realpathSync throws an error', async () => {
      const rawCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-realpath-err-'));
      // Resolve to real path first to handle macOS /var -> /private/var symlink
      const cwd = fs.realpathSync(rawCwd);
      const testPath = path.join(cwd, 'test-path');
      fs.mkdirSync(testPath, { recursive: true });

      // Reset modules so we can re-import with mocked fs
      jest.resetModules();

      // Set up mocks after directory creation but before importing the module
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(() => {
        throw new Error('ELOOP: too many symbolic links');
      });

      try {
        // Re-import the module to pick up the mocked fs
        const { normalizeExternalRoots: mockedNormalizeExternalRoots } = await import('@/kernel/index.ts');
        const roots = mockedNormalizeExternalRoots(cwd, [testPath]);

        expect(roots).toEqual([testPath]);
        expect(warnSpy).toHaveBeenCalledWith(
          'external_roots.path_resolution_warning',
          expect.objectContaining({
            path: testPath,
            warning: 'failed to resolve realpath: ELOOP: too many symbolic links'
          })
        );
      } finally {
        warnSpy.mockRestore();
        existsSpy.mockRestore();
        realpathSpy.mockRestore();
        jest.resetModules();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('warns when realpathSync throws a non-Error value', async () => {
      const rawCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-realpath-nonerr-'));
      const cwd = fs.realpathSync(rawCwd);
      const testPath = path.join(cwd, 'test-path');
      fs.mkdirSync(testPath, { recursive: true });

      jest.resetModules();

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string error message';
      });

      try {
        const { normalizeExternalRoots: mockedNormalizeExternalRoots } = await import('@/kernel/index.ts');
        const roots = mockedNormalizeExternalRoots(cwd, [testPath]);

        expect(roots).toEqual([testPath]);
        expect(warnSpy).toHaveBeenCalledWith(
          'external_roots.path_resolution_warning',
          expect.objectContaining({
            path: testPath,
            warning: 'failed to resolve realpath: string error message'
          })
        );
      } finally {
        warnSpy.mockRestore();
        existsSpy.mockRestore();
        realpathSpy.mockRestore();
        jest.resetModules();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
