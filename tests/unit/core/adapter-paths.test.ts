import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd, writeJson } from '@tests/helpers/temp-files.ts';

describe('core/adapter-paths', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.LLM_ADAPTER_PATHS_FILE;
  });

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.LLM_ADAPTER_PATHS_FILE;
  });

  test('uses LLM_ADAPTER_PATHS_FILE when it exists (wins over cwd file)', async () => {
    await withTempCwd('adapter-paths-env-wins', async (cwd) => {
      const envFile = path.join(cwd, 'custom.paths.json');
      const cwdFile = path.join(cwd, 'llm-adapter.paths.json');

      writeJson(envFile, { paths: { plugins: './plugins-from-env' } });
      writeJson(cwdFile, { paths: { plugins: './plugins-from-cwd' } });

      process.env.LLM_ADAPTER_PATHS_FILE = envFile;

      const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
      const loaded = getAdapterPathsConfig();

      expect(loaded?.filePath).toBe(envFile);
      expect(loaded?.source).toBe('env');
      expect(loaded?.paths.plugins).toBe('./plugins-from-env');
    });
  });

  test('warns and falls back when LLM_ADAPTER_PATHS_FILE is set but missing', async () => {
    await withTempCwd('adapter-paths-env-missing', async (cwd) => {
      const missingEnvFile = path.join(cwd, 'missing.paths.json');
      const cwdFile = path.join(cwd, 'llm-adapter.paths.json');
      writeJson(cwdFile, { paths: { plugins: './plugins-from-cwd' } });

      process.env.LLM_ADAPTER_PATHS_FILE = missingEnvFile;

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
        const loaded = getAdapterPathsConfig();

        expect(warnSpy).toHaveBeenCalled();
        expect((warnSpy.mock.calls[0]?.[1] as any)?.envVar).toBe('LLM_ADAPTER_PATHS_FILE');
        expect(loaded?.filePath).toBe(fs.realpathSync(cwdFile));
        expect(loaded?.source).toBe('cwd');
        expect(loaded?.paths.plugins).toBe('./plugins-from-cwd');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('walks up to find llm-adapter.paths.json in a parent directory', async () => {
    await withTempCwd('adapter-paths-walk-up', async (root) => {
      const configPath = path.join(root, 'llm-adapter.paths.json');
      writeJson(configPath, { paths: { plugins: './plugins-from-parent' } });

      const nested = path.join(root, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      const previous = process.cwd();
      process.chdir(nested);

      try {
        jest.resetModules();
        const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
        const loaded = getAdapterPathsConfig();

        expect(loaded?.filePath).toBe(fs.realpathSync(configPath));
        expect(loaded?.source).toBe('walk-up');
        expect(loaded?.paths.plugins).toBe('./plugins-from-parent');
      } finally {
        process.chdir(previous);
      }
    });
  });

  test('returns null and warns when JSON is invalid', async () => {
    await withTempCwd('adapter-paths-invalid-json', async (cwd) => {
      const filePath = path.join(cwd, 'llm-adapter.paths.json');
      fs.writeFileSync(filePath, '{not-json', 'utf-8');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
        const loaded = getAdapterPathsConfig();

        expect(loaded).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        expect((warnSpy.mock.calls[0]?.[1] as any)?.filePath).toContain('llm-adapter.paths.json');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('normalizes externalRoots (absolute, trimmed, deduped) and per-area overrides', async () => {
    await withTempCwd('adapter-paths-normalization', async (cwd) => {
      const filePath = path.join(cwd, 'llm-adapter.paths.json');
      writeJson(filePath, {
        paths: {
          lookup: {
            plugins: {
              externalRoots: ['./pack-a', '  ./pack-b  ', './pack-a', '', 123],
              areas: {
                tools: { local: false, externalRoots: ['./tools-pack', './tools-pack'] }
              }
            }
          }
        }
      });

      const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
      const loaded = getAdapterPathsConfig();

      const realCwd = fs.realpathSync(cwd);
      expect(loaded?.paths.lookup.warnOnOverride).toBe(true);
      expect(loaded?.paths.lookup.plugins.builtinManifests).toBe(false);
      expect(loaded?.paths.lookup.plugins.builtinCode).toBe(true);
      expect(loaded?.paths.lookup.plugins.local).toBe(true);

      expect(loaded?.paths.lookup.plugins.externalRoots).toEqual([
        path.resolve(realCwd, 'pack-a'),
        path.resolve(realCwd, 'pack-b')
      ]);

      expect(loaded?.paths.lookup.plugins.areas.tools).toEqual({
        local: false,
        externalRoots: [path.resolve(realCwd, 'tools-pack')]
      });
    });
  });

  test('applies ${ENV} substitutions to llm-adapter.paths.json', async () => {
    await withTempCwd('adapter-paths-env-subst', async (cwd) => {
      process.env.TEST_PLUGINS_PATH = './plugins-from-env-subst';

      const filePath = path.join(cwd, 'llm-adapter.paths.json');
      writeJson(filePath, { paths: { plugins: '${TEST_PLUGINS_PATH}' } });

      const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
      const loaded = getAdapterPathsConfig();
      expect(loaded?.paths.plugins).toBe('./plugins-from-env-subst');
    });
  });

  test('caches the parsed config (does not re-read file)', async () => {
    await withTempCwd('adapter-paths-cache', async (cwd) => {
      const filePath = path.join(cwd, 'llm-adapter.paths.json');
      writeJson(filePath, { paths: { plugins: './plugins-first' } });

      const readSpy = jest.spyOn(fs, 'readFileSync');
      try {
        const { getAdapterPathsConfig, resetAdapterPathsConfigCache } = await import('@/kernel/index.ts');
        resetAdapterPathsConfigCache();

        const first = getAdapterPathsConfig();
        writeJson(filePath, { paths: { plugins: './plugins-second' } });
        const second = getAdapterPathsConfig();

        expect(first?.paths.plugins).toBe('./plugins-first');
        expect(second?.paths.plugins).toBe('./plugins-first');
        const canonicalFilePath = fs.realpathSync(filePath);
        const readsOfPathsFile = readSpy.mock.calls.filter(call => call[0] === canonicalFilePath);
        expect(readsOfPathsFile).toHaveLength(1);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  test('returns null when no paths config exists anywhere (and caches null)', async () => {
    await withTempCwd('adapter-paths-none', async () => {
      const { getAdapterPathsConfig, resetAdapterPathsConfigCache } = await import('@/kernel/index.ts');
      resetAdapterPathsConfigCache();

      expect(getAdapterPathsConfig()).toBeNull();
      expect(getAdapterPathsConfig()).toBeNull();
    });
  });

  test('resolves LLM_ADAPTER_PATHS_FILE relative to process.cwd()', async () => {
    await withTempCwd('adapter-paths-env-relative', async (cwd) => {
      const relDir = path.join(cwd, 'rel');
      fs.mkdirSync(relDir, { recursive: true });
      const relFile = path.join(relDir, 'llm.paths.json');
      writeJson(relFile, { paths: { plugins: './plugins-from-relative-env' } });

      process.env.LLM_ADAPTER_PATHS_FILE = './rel/llm.paths.json';

      const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
      const loaded = getAdapterPathsConfig();
      expect(loaded?.source).toBe('env');
      expect(loaded?.filePath).toBe(path.join(fs.realpathSync(cwd), 'rel', 'llm.paths.json'));
    });
  });

  test('normalizes booleans, absolute roots, and skips invalid area overrides', async () => {
    await withTempCwd('adapter-paths-branches', async (cwd) => {
      const absPack = path.join(fs.realpathSync(cwd), 'abs-pack');
      const filePath = path.join(cwd, 'llm-adapter.paths.json');

      writeJson(filePath, {
        paths: {
          lookup: {
            warnOnOverride: false,
            extensions: { builtin: false, externalRoots: 'not-an-array' },
            plugins: {
              builtinManifests: true,
              builtinCode: false,
              local: false,
              externalRoots: [absPack],
              areas: {
                '   ': { local: true },
                empty: { hello: 'world' },
                bad: 123,
                providers: { builtinManifests: true, builtinCode: false },
                tools: { externalRoots: 'still-not-an-array' }
              }
            },
            configs: {
              defaults: { builtin: false, local: false, externalRoots: [] },
              usageCosts: { builtin: false, local: false, externalRoots: [] }
            }
          }
        }
      });

      const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
      const loaded = getAdapterPathsConfig();

      expect(loaded?.paths.lookup.warnOnOverride).toBe(false);
      expect(loaded?.paths.lookup.extensions).toEqual({ builtin: false, externalRoots: [] });
      expect(loaded?.paths.lookup.plugins.externalRoots).toEqual([absPack]);
      expect(loaded?.paths.lookup.plugins.builtinManifests).toBe(true);
      expect(loaded?.paths.lookup.plugins.builtinCode).toBe(false);
      expect(loaded?.paths.lookup.plugins.local).toBe(false);
      expect(loaded?.paths.lookup.configs.defaults).toEqual({ builtin: false, local: false, externalRoots: [] });
      expect(loaded?.paths.lookup.configs.usageCosts).toEqual({ builtin: false, local: false, externalRoots: [] });

      expect(loaded?.paths.lookup.plugins.areas.providers).toEqual({
        builtinManifests: true,
        builtinCode: false
      });
      expect(loaded?.paths.lookup.plugins.areas.tools).toEqual({
        externalRoots: []
      });

      expect(loaded?.paths.lookup.plugins.areas).not.toHaveProperty('empty');
      expect(loaded?.paths.lookup.plugins.areas).not.toHaveProperty('bad');
      expect(loaded?.paths.lookup.plugins.areas).not.toHaveProperty('   ');
    });
  });

  test('treats non-object JSON roots as empty config (defaults only)', async () => {
    await withTempCwd('adapter-paths-non-object', async (cwd) => {
      const filePath = path.join(cwd, 'llm-adapter.paths.json');
      fs.writeFileSync(filePath, JSON.stringify('not-an-object'), 'utf-8');

      const { getAdapterPathsConfig } = await import('@/kernel/index.ts');
      const loaded = getAdapterPathsConfig();

      expect(loaded?.paths.plugins).toBeUndefined();
      expect(loaded?.paths.lookup.warnOnOverride).toBe(true);
      expect(loaded?.paths.lookup.plugins.externalRoots).toEqual([]);
    });
  });
});
