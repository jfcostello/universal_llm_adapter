import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { jest } from '@jest/globals';
import { ManifestError } from '../../../../kernel/index.js';
import { createVoiceProviderPlugins } from '../../internal/provider-plugins.js';

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
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeJson(path.join(tmp, 'voice-providers', 'provider-a.json'), {
        id: 'provider-a',
        kind: 'compat-a',
        defaults: { a: 1 }
      });

      await writeCompatModule(
        path.join(tmp, 'voice-compat', 'compat-a', 'index.js'),
        [
          "globalThis.__voiceProviderCompatImported = (globalThis.__voiceProviderCompatImported || 0) + 1;",
          "globalThis.__voiceProviderCompatConstructed = globalThis.__voiceProviderCompatConstructed || 0;",
          'module.exports = class CompatA {',
          '  constructor() { globalThis.__voiceProviderCompatConstructed++; this.kind = "compat-a"; }',
          '};'
        ].join('\n')
      );

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp });

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
    } finally {
      warn.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
      delete (globalThis as any).__voiceProviderCompatImported;
      delete (globalThis as any).__voiceProviderCompatConstructed;
    }
  });

  test('resolves legacy single-file compat modules (.js and .ts)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeJson(path.join(tmp, 'voice-providers', 'file-js.json'), {
        id: 'file-js',
        kind: 'file-js'
      });
      await writeCompatModule(
        path.join(tmp, 'voice-compat', 'file-js.js'),
        'module.exports = class FileJsCompat { kind = "file-js"; };'
      );

      const jsCompat = await createVoiceProviderPlugins({ pluginsPath: tmp }).getCompat('file-js');
      expect(jsCompat).toEqual(expect.objectContaining({ kind: 'file-js' }));

      await writeJson(path.join(tmp, 'voice-providers', 'file-ts.json'), {
        id: 'file-ts',
        kind: 'file-ts'
      });
      await writeCompatModule(path.join(tmp, 'voice-compat', 'file-ts.ts'), '');

      const tsCompat = await createVoiceProviderPlugins({
        pluginsPath: tmp,
        importModule: async () => ({
          default: class FileTsCompat {
            kind = 'file-ts';
          }
        })
      }).getCompat('file-ts');
      expect(tsCompat).toEqual(expect.objectContaining({ kind: 'file-ts' }));
    } finally {
      warn.mockRestore();
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
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeJson(path.join(tmp, 'voice-providers', 'evil.json'), {
        id: 'evil',
        kind: '../evil'
      });

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp });
      await expect(plugins.getCompat('evil')).rejects.toBeInstanceOf(ManifestError);
    } finally {
      warn.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('validates manifests and handles duplicates', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeJson(path.join(tmp, 'voice-providers', 'bad-type.json'), 'not-an-object');
      await writeJson(path.join(tmp, 'voice-providers', 'dup-a.json'), { id: 'dup', kind: 'k1', defaults: [] });
      await writeJson(path.join(tmp, 'voice-providers', 'dup-b.json'), { id: 'dup', kind: 'k2', defaults: 123 });

      const plugins = createVoiceProviderPlugins({ pluginsPath: tmp });
      const manifests = await plugins.listManifests();
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.id).toBe('dup');
      expect(['k1', 'k2']).toContain(manifests[0]?.kind);
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
    try {
      await writeJson(path.join(tmp, 'voice-providers', 'missing-compat.json'), {
        id: 'missing-compat',
        kind: 'missing-kind'
      });
      await fs.mkdir(path.join(tmp, 'voice-compat'), { recursive: true });

      await expect(
        createVoiceProviderPlugins({ pluginsPath: tmp }).getCompat('missing-compat')
      ).rejects.toBeInstanceOf(ManifestError);

      await writeJson(path.join(tmp, 'voice-providers', 'invalid-compat.json'), {
        id: 'invalid-compat',
        kind: 'invalid-kind'
      });
      await writeCompatModule(path.join(tmp, 'voice-compat', 'invalid-kind', 'index.js'), 'module.exports = {};');
      await expect(
        createVoiceProviderPlugins({ pluginsPath: tmp }).getCompat('invalid-compat')
      ).rejects.toBeInstanceOf(ManifestError);

      await writeJson(path.join(tmp, 'voice-providers', 'ts-only.json'), {
        id: 'ts-only',
        kind: 'ts-only'
      });
      await writeCompatModule(path.join(tmp, 'voice-compat', 'ts-only', 'index.ts'), 'not valid ts');
      await expect(
        createVoiceProviderPlugins({ pluginsPath: tmp }).getCompat('ts-only')
      ).rejects.toBeInstanceOf(ManifestError);
    } finally {
      warn.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('supports compat modules without default export (first export wins)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-provider-plugins-'));
    try {
      await writeJson(path.join(tmp, 'voice-providers', 'no-default.json'), {
        id: 'no-default',
        kind: 'no-default'
      });
      await writeCompatModule(path.join(tmp, 'voice-compat', 'no-default', 'index.js'), 'module.exports = {};');

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
});
