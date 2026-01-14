import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { jest } from '@jest/globals';
import { ManifestError } from '../../../../kernel/index.js';
import { createVoiceProviderPlugins } from '../../modules/provider-plugins/index.js';

async function writeJson(filePath: string, value: any): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function writeCompatModule(filePath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, 'utf-8');
}

describe('extensions/voice: provider plugins loader', () => {
  test('listManifests is cached and supports relative pluginsPath', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      const rel = path.relative(process.cwd(), tmp);
      const plugins = createVoiceProviderPlugins({ pluginsPath: rel });

      expect(await plugins.listManifests()).toEqual([]);
      expect(await plugins.listManifests()).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('discovers manifests and loads compat lazily (no eager import)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const logger = { warning: jest.fn() };
    try {
      await writeJson(path.join(tmp, 'providers', 'provider-a.json'), {
        id: 'provider-a',
        kind: 'compat-a',
        defaults: { a: 1 }
      });

      await writeCompatModule(
        path.join(tmp, 'compat', 'compat-a', 'index.js'),
        [
          "globalThis.__voiceProviderCompatImported = (globalThis.__voiceProviderCompatImported || 0) + 1;",
          "globalThis.__voiceProviderCompatConstructed = globalThis.__voiceProviderCompatConstructed || 0;",
          'module.exports = class CompatA {',
          '  constructor() { globalThis.__voiceProviderCompatConstructed++; this.kind = "compat-a"; }',
          '};'
        ].join('\n')
      );

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp, logger });

      const manifest = await plugins.getManifest('provider-a');
      expect(manifest).toEqual({
        id: 'provider-a',
        kind: 'compat-a',
        defaults: { a: 1 }
      });

      expect((globalThis as any).__voiceProviderCompatImported).toBeUndefined();
      expect((globalThis as any).__voiceProviderCompatConstructed).toBeUndefined();

      const compat1 = await plugins.getCompat('provider-a');
      expect(compat1).toEqual(expect.objectContaining({ kind: 'compat-a' }));
      expect((globalThis as any).__voiceProviderCompatImported).toBe(1);
      expect((globalThis as any).__voiceProviderCompatConstructed).toBe(1);

      const compat2 = await plugins.getCompat('provider-a');
      expect(compat2).toEqual(expect.objectContaining({ kind: 'compat-a' }));

      // Module import should be cached, but factory returns new instance each time.
      expect((globalThis as any).__voiceProviderCompatImported).toBe(1);
      expect((globalThis as any).__voiceProviderCompatConstructed).toBe(2);
      expect(logger.warning).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      delete (globalThis as any).__voiceProviderCompatImported;
      delete (globalThis as any).__voiceProviderCompatConstructed;
    }
  });

  test('resolves legacy single-file compat modules (.js and .ts)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const logger = { warning: jest.fn() };
    try {
      await writeJson(path.join(tmp, 'providers', 'file-js.json'), {
        id: 'file-js',
        kind: 'file-js'
      });
      await writeCompatModule(
        path.join(tmp, 'compat', 'file-js.js'),
        'module.exports = class FileJsCompat { kind = "file-js"; };'
      );

      const jsCompat = await createVoiceProviderPlugins({ pluginsPath: tmp, logger }).getCompat('file-js');
      expect(jsCompat).toEqual(expect.objectContaining({ kind: 'file-js' }));

      await writeJson(path.join(tmp, 'providers', 'file-ts.json'), {
        id: 'file-ts',
        kind: 'file-ts'
      });
      await writeCompatModule(path.join(tmp, 'compat', 'file-ts.ts'), '');

      const tsCompat = await createVoiceProviderPlugins({
        pluginsPath: tmp,
        logger,
        importModule: async () => ({
          default: class FileTsCompat {
            kind = 'file-ts';
          }
        })
      }).getCompat('file-ts');
      expect(tsCompat).toEqual(expect.objectContaining({ kind: 'file-ts' }));
      expect(logger.warning).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('throws on unknown voice provider id', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp });
      await expect(plugins.getManifest('missing')).rejects.toBeInstanceOf(ManifestError);
      await expect(plugins.getCompat('missing')).rejects.toBeInstanceOf(ManifestError);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('hardens against path traversal in compat kind', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const logger = { warning: jest.fn() };
    try {
      await writeCompatModule(
        path.join(tmp, 'compat', 'index.js'),
        [
          "globalThis.__voiceCompatPoisoned = (globalThis.__voiceCompatPoisoned || 0) + 1;",
          'module.exports = class PoisonCompat { kind = "poison"; };'
        ].join('\n')
      );
      await writeCompatModule(
        path.join(tmp, 'index.js'),
        [
          "globalThis.__voiceCompatPoisoned = (globalThis.__voiceCompatPoisoned || 0) + 1;",
          'module.exports = class PoisonCompat { kind = "poison"; };'
        ].join('\n')
      );

      await writeJson(path.join(tmp, 'providers', 'dot.json'), { id: 'dot', kind: '.' });
      await writeJson(path.join(tmp, 'providers', 'dotdot.json'), { id: 'dotdot', kind: '..' });
      await writeJson(path.join(tmp, 'providers', 'evil.json'), {
        id: 'evil',
        kind: '../evil'
      });

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp, logger });
      await expect(plugins.getCompat('dot')).rejects.toBeInstanceOf(ManifestError);
      await expect(plugins.getCompat('dotdot')).rejects.toBeInstanceOf(ManifestError);
      await expect(plugins.getCompat('evil')).rejects.toBeInstanceOf(ManifestError);
      expect((globalThis as any).__voiceCompatPoisoned).toBeUndefined();

      const warningMessages = logger.warning.mock.calls.map(([msg]) => msg);
      expect(warningMessages).toEqual(expect.arrayContaining(['voice.provider_plugins.manifest_skipped']));

      const warningPaths = logger.warning.mock.calls.map(([, data]) => (data as any)?.manifestPath);
      expect(warningPaths).toEqual(
        expect.arrayContaining(['providers/dot.json', 'providers/dotdot.json', 'providers/evil.json'])
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      delete (globalThis as any).__voiceCompatPoisoned;
    }
  });

  test('validates manifests and handles duplicates', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = { warning: jest.fn() };
    try {
      await writeJson(path.join(tmp, 'providers', 'bad-type.json'), 'not-an-object');
      await writeJson(path.join(tmp, 'providers', 'dup-a.json'), { id: 'dup', kind: 'k1', defaults: [] });
      await writeJson(path.join(tmp, 'providers', 'dup-b.json'), { id: 'dup', kind: 'k2', defaults: 123 });

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp, logger });
      const manifests = await plugins.listManifests();
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.id).toBe('dup');
      expect(['k1', 'k2']).toContain(manifests[0]?.kind);

      expect(logger.warning).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(
        logger.warning.mock.calls.some(
          ([msg, data]) => msg === 'voice.provider_plugins.manifest_skipped' && (data as any)?.manifestPath === 'providers/bad-type.json'
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('falls back to console.warn when a logger is not provided', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeJson(path.join(tmp, 'providers', 'bad-type.json'), 'not-an-object');

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp });
      expect(await plugins.listManifests()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'voice.provider_plugins.manifest_skipped',
        expect.objectContaining({ manifestPath: 'providers/bad-type.json' })
      );
    } finally {
      warn.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('throws on invalid provider ids', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp });
      await expect((plugins as any).getManifest('')).rejects.toBeInstanceOf(ManifestError);
      await expect((plugins as any).getManifest(123)).rejects.toBeInstanceOf(ManifestError);
      await expect((plugins as any).getManifest('bad/name')).rejects.toBeInstanceOf(ManifestError);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('throws when compat module is missing or invalid', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = { warning: jest.fn() };
    try {
      await writeJson(path.join(tmp, 'providers', 'missing-compat.json'), {
        id: 'missing-compat',
        kind: 'missing-kind'
      });
      await fs.mkdir(path.join(tmp, 'compat'), { recursive: true });

      await expect(
        createVoiceProviderPlugins({ pluginsPath: tmp, logger }).getCompat('missing-compat')
      ).rejects.toBeInstanceOf(ManifestError);

      await writeJson(path.join(tmp, 'providers', 'invalid-compat.json'), {
        id: 'invalid-compat',
        kind: 'invalid-kind'
      });
      await writeCompatModule(path.join(tmp, 'compat', 'invalid-kind', 'index.js'), 'module.exports = {};');
      await expect(
        createVoiceProviderPlugins({ pluginsPath: tmp, logger }).getCompat('invalid-compat')
      ).rejects.toBeInstanceOf(ManifestError);

      await writeJson(path.join(tmp, 'providers', 'ts-only.json'), {
        id: 'ts-only',
        kind: 'ts-only'
      });
      await writeCompatModule(path.join(tmp, 'compat', 'ts-only', 'index.ts'), 'not valid ts');
      await expect(
        createVoiceProviderPlugins({ pluginsPath: tmp, logger }).getCompat('ts-only')
      ).rejects.toBeInstanceOf(ManifestError);

      expect(warn).not.toHaveBeenCalled();
      expect(logger.warning.mock.calls.some(([msg]) => msg === 'voice.provider_plugins.compat_load_failed')).toBe(true);
    } finally {
      warn.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('skips non-existent compat roots when resolving', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      await writeJson(path.join(tmp, 'providers', 'missing-root.json'), {
        id: 'missing-root',
        kind: 'missing-kind-xyz'
      });

      await expect(createVoiceProviderPlugins({ pluginsPath: tmp }).getCompat('missing-root')).rejects.toBeInstanceOf(ManifestError);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('supports compat modules without default export (first export wins)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      await writeJson(path.join(tmp, 'providers', 'no-default.json'), {
        id: 'no-default',
        kind: 'no-default'
      });
      await writeCompatModule(path.join(tmp, 'compat', 'no-default', 'index.js'), 'module.exports = {};');

      const plugins = createVoiceProviderPlugins({
        pluginsPath: tmp,
        importModule: async () => ({
          Named: class NamedCompat {
            kind = 'no-default';
          }
        })
      });

      const compat = await plugins.getCompat('no-default');
      expect(compat).toEqual(expect.objectContaining({ kind: 'no-default' }));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('defaults pluginsPath to the built-in voice extension plugins root', async () => {
    const plugins = createVoiceProviderPlugins({});
    const manifests = await plugins.listManifests();
    expect(manifests.some(m => m.id === 'test')).toBe(true);
  });

  test('treats a missing pluginsPath directory as an empty manifest set', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      const missing = path.join(tmp, 'missing-root');
      const plugins = createVoiceProviderPlugins({ pluginRoots: missing });
      await expect(plugins.listManifests()).resolves.toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  describe('multi-root plugin resolution', () => {
    test('combines manifests from multiple roots', async () => {
      const root1 = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root1-'));
      const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root2-'));
      try {
        // Provider A only in root1
        await writeJson(path.join(root1, 'providers', 'provider-a.json'), {
          id: 'provider-a',
          kind: 'kind-a'
        });

        // Provider B only in root2
        await writeJson(path.join(root2, 'providers', 'provider-b.json'), {
          id: 'provider-b',
          kind: 'kind-b'
        });

        const plugins = createVoiceProviderPlugins({ pluginRoots: [root1, root2] });
        const manifests = await plugins.listManifests();

        expect(manifests).toHaveLength(2);
        expect(manifests.map(m => m.id).sort()).toEqual(['provider-a', 'provider-b']);
      } finally {
        await fs.rm(root1, { recursive: true, force: true });
        await fs.rm(root2, { recursive: true, force: true });
      }
    });

    test('warns and overrides on duplicate provider ID across roots (last wins)', async () => {
      const root1 = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root1-'));
      const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root2-'));
      const logger = { warning: jest.fn() };
      try {
        // Same provider ID in both roots
        await writeJson(path.join(root1, 'providers', 'dup-provider.json'), {
          id: 'dup-provider',
          kind: 'kind-1'
        });
        await writeJson(path.join(root2, 'providers', 'dup-provider.json'), {
          id: 'dup-provider',
          kind: 'kind-2'
        });

        const plugins = createVoiceProviderPlugins({ pluginRoots: [root1, root2], logger });

        // listManifests should warn about override
        const manifests = await plugins.listManifests();

        // Only one manifest loaded - last root wins (override)
        expect(manifests).toHaveLength(1);
        expect(manifests[0]?.kind).toBe('kind-2'); // root2 wins

        // Should have warned about the override
        expect(logger.warning).toHaveBeenCalledWith(
          'voice.provider_plugins.override',
          expect.objectContaining({
            id: 'dup-provider',
            previous: expect.stringContaining('dup-provider.json'),
            next: expect.stringContaining('dup-provider.json')
          })
        );
      } finally {
        await fs.rm(root1, { recursive: true, force: true });
        await fs.rm(root2, { recursive: true, force: true });
      }
    });

    test('resolves compat from first root that has it (first-match-wins)', async () => {
      const root1 = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root1-'));
      const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root2-'));
      try {
        // Manifest in root1
        await writeJson(path.join(root1, 'providers', 'provider-x.json'), {
          id: 'provider-x',
          kind: 'kind-x'
        });

        // Compat only in root2 (not in root1)
        await writeCompatModule(
          path.join(root2, 'compat', 'kind-x', 'index.js'),
          'module.exports = class KindXCompat { kind = "kind-x"; };'
        );

        const plugins = createVoiceProviderPlugins({ pluginRoots: [root1, root2] });
        const compat = await plugins.getCompat('provider-x');

        expect(compat).toEqual(expect.objectContaining({ kind: 'kind-x' }));
      } finally {
        await fs.rm(root1, { recursive: true, force: true });
        await fs.rm(root2, { recursive: true, force: true });
      }
    });

    test('skips empty and non-existent roots in multi-root array', async () => {
      const validRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root-valid-'));
      try {
        await writeJson(path.join(validRoot, 'providers', 'provider-y.json'), {
          id: 'provider-y',
          kind: 'kind-y'
        });

        const missingRoot = path.join(os.tmpdir(), 'non-existent-voice-root-xyz');
        const plugins = createVoiceProviderPlugins({ pluginRoots: [missingRoot, validRoot] });
        const manifests = await plugins.listManifests();

        expect(manifests).toHaveLength(1);
        expect(manifests[0]?.id).toBe('provider-y');
      } finally {
        await fs.rm(validRoot, { recursive: true, force: true });
      }
    });

    test('handles empty pluginRoots array by using defaults', async () => {
      const plugins = createVoiceProviderPlugins({ pluginRoots: [] });
      const manifests = await plugins.listManifests();
      // Should use default VOICE_EXTENSION_PLUGIN_ROOTS which includes built-in test provider
      expect(manifests.some(m => m.id === 'test')).toBe(true);
    });

    test('normalizes relative paths in pluginRoots array', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-multi-root-rel-'));
      try {
        await writeJson(path.join(tmp, 'providers', 'provider-rel.json'), {
          id: 'provider-rel',
          kind: 'kind-rel'
        });

        const relativePath = path.relative(process.cwd(), tmp);
        const plugins = createVoiceProviderPlugins({ pluginRoots: [relativePath] });
        const manifests = await plugins.listManifests();

        expect(manifests).toHaveLength(1);
        expect(manifests[0]?.id).toBe('provider-rel');
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    test('legacy pluginsPath string is normalized to single-element array', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-legacy-path-'));
      try {
        await writeJson(path.join(tmp, 'providers', 'legacy-provider.json'), {
          id: 'legacy-provider',
          kind: 'legacy-kind'
        });

        // Using the old pluginsPath API (single string)
        const plugins = createVoiceProviderPlugins({ pluginRoots: tmp });
        const manifests = await plugins.listManifests();

        expect(manifests).toHaveLength(1);
        expect(manifests[0]?.id).toBe('legacy-provider');
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
