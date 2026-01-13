import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('kernel/registry manifest-loader', () => {
  test('forEachManifestFile catches errors in non-strict legacy mode', async () => {
    const { forEachManifestFile } = await import('@/kernel/internal/registry/internal/manifest-loader.ts');

    await withTempCwd('manifest-loader-legacy', async (dir) => {
      fs.mkdirSync(path.join(dir, 'providers'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'providers', 'a.json'), '{}', 'utf-8');

      const state: any = { mode: 'legacy', rootPath: dir, manifestSources: new Map(), lookup: null };

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const seen: any[] = [];

        await forEachManifestFile(
          state,
          { area: 'providers', pattern: 'providers/*.json', strict: false, skipLabel: 'provider manifest' },
          (file) => {
            seen.push(file);
            throw undefined;
          }
        );

        expect(seen).toHaveLength(1);
        expect(seen[0].isMultiRoot).toBe(false);
        expect(seen[0].source.kind).toBe('local');
        expect(warn).toHaveBeenCalledWith('Skipping provider manifest providers/a.json: undefined');
      } finally {
        warn.mockRestore();
      }
    });
  });

  test('forEachManifestFile rethrows errors in strict mode', async () => {
    const { forEachManifestFile } = await import('@/kernel/internal/registry/internal/manifest-loader.ts');

    await withTempCwd('manifest-loader-legacy-strict', async (dir) => {
      fs.mkdirSync(path.join(dir, 'providers'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'providers', 'a.json'), '{}', 'utf-8');

      const state: any = { mode: 'legacy', rootPath: dir, manifestSources: new Map(), lookup: null };

      await expect(
        forEachManifestFile(
          state,
          { area: 'providers', pattern: 'providers/*.json', strict: true, skipLabel: 'provider manifest' },
          () => {
            throw new Error('boom');
          }
        )
      ).rejects.toThrow('boom');
    });
  });

  test('forEachManifestFile returns deterministic multi-root file metadata', async () => {
    const { forEachManifestFile } = await import('@/kernel/internal/registry/internal/manifest-loader.ts');

    await withTempCwd('manifest-loader-multi', async (dir) => {
      fs.mkdirSync(path.join(dir, 'providers'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'providers', 'b.json'), '{}', 'utf-8');

      const state: any = {
        mode: 'multi-root',
        rootPath: dir,
        manifestSources: new Map(),
        lookup: {
          warnOnOverride: true,
          base: { builtinManifests: false, builtinCode: true, local: true, externalRoots: [] },
          areas: {}
        }
      };

      const seen: any[] = [];
      await forEachManifestFile(
        state,
        { area: 'providers', pattern: 'providers/*.json', strict: true, skipLabel: 'provider manifest' },
        (file) => {
          seen.push(file);
        }
      );

      expect(seen).toHaveLength(1);
      expect(seen[0].isMultiRoot).toBe(true);
      expect(seen[0].file).toBe('providers/b.json');
      expect(seen[0].source.kind).toBe('local');
      expect(seen[0].source.root).toBe(dir);
      expect(seen[0].source.precedence).toBe(0);
    });
  });

  test('upsertManifestWithSource stores sources and warns on override', async () => {
    const { upsertManifestWithSource } = await import('@/kernel/internal/registry/internal/manifest-loader.ts');

    const state: any = {
      manifestSources: new Map(),
      lookup: { warnOnOverride: true }
    };

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = { kind: 'local', root: '/a', filePath: '/a/providers/first.json', precedence: 0 };
      upsertManifestWithSource(state, 'providers', 'first', first as any, () => {});
      expect(state.manifestSources.get('providers:first')).toEqual(first);
      expect(warn).not.toHaveBeenCalled();

      const previous = { kind: 'local', root: '/a', filePath: '/a/providers/second.json', precedence: 0 };
      state.manifestSources.set('providers:second', previous);
      const next = { kind: 'external', root: '/b', filePath: '/b/providers/second.json', precedence: 1 };
      upsertManifestWithSource(state, 'providers', 'second', next as any, () => {});

      expect(state.manifestSources.get('providers:second')).toEqual(next);
      expect(warn).toHaveBeenCalledWith('plugin_registry.override', {
        area: 'providers',
        id: 'second',
        previous: { kind: previous.kind, root: previous.root, filePath: previous.filePath, precedence: previous.precedence },
        next: { kind: next.kind, root: next.root, filePath: next.filePath, precedence: next.precedence }
      });
    } finally {
      warn.mockRestore();
    }
  });
});
