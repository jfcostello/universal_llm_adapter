import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import { PACKAGE_ROOT } from '@/kernel/index.ts';
import {
  listExtensions,
  loadExtensionDefaults,
  mergeExtensionConfig,
  resolveExtensionEntry
} from '@/modules/extensions/index.ts';
import { withTempCwd, writeJson } from '@tests/helpers/temp-files.ts';

describe('modules/extensions', () => {
  test('resolves builtin extensions when no llm-adapter.paths.json exists', async () => {
    await withTempCwd('extensions-resolve-builtin', async () => {
      const resolved = resolveExtensionEntry('voice');
      expect(resolved?.name).toBe('voice');
      expect(resolved?.kind).toBe('builtin');
      expect(resolved?.entryFilePath).toContain(path.join('extensions', 'voice', 'index.'));
    });
  });

  test('external roots override builtin extensions (warns)', async () => {
    await withTempCwd('extensions-resolve-override', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'voice'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'voice', 'index.js'),
        "export default { name: 'voice' };",
        'utf-8'
      );

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: true, externalRoots: ['./pack-a'] }
          }
        }
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const resolved = resolveExtensionEntry('voice');
        expect(resolved?.kind).toBe('external');
        expect(resolved?.root).toBe(fs.realpathSync(path.resolve(cwd, 'pack-a')));
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('listExtensions scans roots and returns only valid extension dirs with an index file', async () => {
    await withTempCwd('extensions-list', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'demo'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'demo', 'index.js'),
        "export default { name: 'demo' };",
        'utf-8'
      );

      fs.mkdirSync(path.join(packRoot, 'extensions', 'Bad'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'Bad', 'index.js'),
        "export default { name: 'Bad' };",
        'utf-8'
      );

      fs.mkdirSync(path.join(packRoot, 'extensions', 'noindex'), { recursive: true });

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      const list = listExtensions();
      expect(list.some(item => item.name === 'demo')).toBe(true);
      expect(list.some(item => item.name === 'Bad')).toBe(false);
      expect(list.some(item => item.name === 'noindex')).toBe(false);
    });
  });

  test('dedupes identical roots (e.g., builtin root repeated in externalRoots)', async () => {
    await withTempCwd('extensions-dedup-roots', async (cwd) => {
      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: true, externalRoots: [PACKAGE_ROOT] }
          }
        }
      });

      const resolved = resolveExtensionEntry('voice');
      expect(resolved?.kind).toBe('builtin');
    });
  });

  test('does not warn on overrides when warnOnOverride is false', async () => {
    await withTempCwd('extensions-override-warn-disabled', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'voice'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'voice', 'index.js'),
        "export default { name: 'voice' };",
        'utf-8'
      );

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            warnOnOverride: false,
            extensions: { builtin: true, externalRoots: ['./pack-a'] }
          }
        }
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const resolved = resolveExtensionEntry('voice');
        expect(resolved?.kind).toBe('external');
        expect(warnSpy.mock.calls.filter(call => call[0] === 'extensions.override')).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('listExtensions warns when an external extension shadows a builtin extension', async () => {
    await withTempCwd('extensions-list-override-warn', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'voice'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'voice', 'index.js'),
        "export default { name: 'voice' };",
        'utf-8'
      );

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: true, externalRoots: ['./pack-a'] }
          }
        }
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const list = listExtensions();
        expect(list.some(item => item.name === 'voice')).toBe(true);
        expect(warnSpy.mock.calls.some(call => call[0] === 'extensions.override')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('warns (but does not fail) when an external root is missing', async () => {
    await withTempCwd('extensions-missing-root', async (cwd) => {
      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: true, externalRoots: ['./missing-pack'] }
          }
        }
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const resolved = resolveExtensionEntry('voice');
        expect(resolved?.kind).toBe('builtin');

        listExtensions();
        expect(warnSpy.mock.calls.some(call => call[0] === 'extensions.root_missing')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('listExtensions skips roots that have no extensions directory', async () => {
    await withTempCwd('extensions-missing-extensions-dir', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'pack-a'), { recursive: true });

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      expect(listExtensions()).toEqual([]);
    });
  });

  test('listExtensions swallows readdirSync errors', async () => {
    await withTempCwd('extensions-readdir-error', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions'), { recursive: true });

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      const readdirSpy = jest.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
        throw new Error('boom');
      });

      try {
        expect(listExtensions()).toEqual([]);
      } finally {
        readdirSpy.mockRestore();
      }
    });
  });

  test('listExtensions ignores non-directory entries and sorts results', async () => {
    await withTempCwd('extensions-sort', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'b', 'index.js'),
        "export default { name: 'b' };",
        'utf-8'
      );

      fs.mkdirSync(path.join(packRoot, 'extensions', 'a'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'a', 'index.js'),
        "export default { name: 'a' };",
        'utf-8'
      );

      fs.mkdirSync(path.join(packRoot, 'extensions'), { recursive: true });
      fs.writeFileSync(path.join(packRoot, 'extensions', 'not-a-dir.txt'), 'hello', 'utf-8');

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      const list = listExtensions();
      expect(list.map(item => item.name)).toEqual(['a', 'b']);
    });
  });

  test('loadExtensionDefaults returns undefined for non-object defaults.json', async () => {
    await withTempCwd('extensions-defaults-non-object', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'demo'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'demo', 'index.js'),
        "export default { name: 'demo' };",
        'utf-8'
      );
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'demo', 'defaults.json'),
        JSON.stringify([1, 2]),
        'utf-8'
      );

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      const resolved = resolveExtensionEntry('demo');
      expect(resolved).toBeDefined();
      expect(loadExtensionDefaults(resolved!)).toBeUndefined();
    });
  });

  test('loadExtensionDefaults warns and returns undefined when defaults.json is invalid JSON', async () => {
    await withTempCwd('extensions-defaults-invalid', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'demo'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'demo', 'index.js'),
        "export default { name: 'demo' };",
        'utf-8'
      );
      fs.writeFileSync(path.join(packRoot, 'extensions', 'demo', 'defaults.json'), '{not-json', 'utf-8');

      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const resolved = resolveExtensionEntry('demo');
        expect(resolved).toBeDefined();
        expect(loadExtensionDefaults(resolved!)).toBeUndefined();
        expect(warnSpy.mock.calls.some(call => call[0] === 'extensions.defaults_invalid')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('mergeExtensionConfig returns defaults, legacy, or undefined based on input shapes', () => {
    expect(mergeExtensionConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeExtensionConfig(undefined, { b: 2 })).toEqual({ b: 2 });
    expect(mergeExtensionConfig(undefined, 123)).toBeUndefined();
  });
});
