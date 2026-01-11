import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('core/defaults baseline + overlay merge (llm-adapter.paths.json)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('preserves legacy behavior when no paths config is present (package defaults win)', async () => {
    await withTempCwd('defaults-no-paths-config', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'plugins', 'configs'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, 'plugins', 'configs', 'defaults.json'),
        JSON.stringify({ tools: { timeoutMs: 1 } }, null, 2),
        'utf-8'
      );

      const { getDefaults, resetDefaultsCache } = await import('@/kernel/index.ts');
      resetDefaultsCache();
      const defaults = getDefaults();
      expect(defaults.tools.timeoutMs).toBe(120000);
    });
  });

  test('deep merges objects and replaces arrays in precedence order (local < external roots)', async () => {
    await withTempCwd('defaults-overlay-merge', async (cwd) => {
      const pathsFile = path.join(cwd, 'llm-adapter.paths.json');
      const localPluginsRoot = path.join(cwd, 'plugins');
      const externalA = path.join(cwd, 'packs', 'a');
      const externalB = path.join(cwd, 'packs', 'b');

      fs.mkdirSync(path.join(localPluginsRoot, 'configs'), { recursive: true });
      fs.mkdirSync(path.join(externalA, 'configs'), { recursive: true });
      fs.mkdirSync(path.join(externalB, 'configs'), { recursive: true });

      fs.writeFileSync(
        pathsFile,
        JSON.stringify(
          {
            paths: {
              plugins: './plugins',
              lookup: {
                configs: {
                  defaults: {
                    builtin: false,
                    local: true,
                    externalRoots: ['./packs/a', './packs/b']
                  },
                  usageCosts: { builtin: false, local: false, externalRoots: [] }
                }
              }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(localPluginsRoot, 'configs', 'defaults.json'),
        JSON.stringify(
          {
            tools: { timeoutMs: 111 },
            retry: { rateLimitDelays: [111] },
            server: { auth: { headerName: 'x-local', apiKeys: ['local-key'] } }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(externalA, 'configs', 'defaults.json'),
        JSON.stringify(
          {
            tools: { timeoutMs: 222 },
            server: { auth: { allowBearer: false, apiKeys: ['ext-a-key'] } }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(externalB, 'configs', 'defaults.json'),
        JSON.stringify(
          {
            tools: { timeoutMs: 333 },
            retry: { rateLimitDelays: [333] },
            server: { auth: { headerName: 'x-ext-b' } }
          },
          null,
          2
        ),
        'utf-8'
      );

      const { getDefaults, resetDefaultsCache } = await import('@/kernel/index.ts');
      resetDefaultsCache();

      const defaults = getDefaults();
      expect(defaults.tools.timeoutMs).toBe(333);
      expect(defaults.retry.rateLimitDelays).toEqual([333]);

      // Deep merge: keep baseline keys, allow nested overrides, and replace arrays.
      expect(defaults.server.auth.enabled).toBe(false);
      expect(defaults.server.auth.allowBearer).toBe(false);
      expect(defaults.server.auth.headerName).toBe('x-ext-b');
      expect(defaults.server.auth.apiKeys).toEqual(['ext-a-key']);
    });
  });

  test('ignores defaults.json when it is not an object (uses baseline fallback)', async () => {
    await withTempCwd('defaults-non-object', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'plugins', 'configs'), { recursive: true });

      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              lookup: {
                configs: {
                  defaults: { builtin: false, local: true, externalRoots: [] },
                  usageCosts: { builtin: false, local: false, externalRoots: [] }
                }
              }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(cwd, 'plugins', 'configs', 'defaults.json'),
        JSON.stringify([1, 2, 3], null, 2),
        'utf-8'
      );

      const { getDefaults, resetDefaultsCache } = await import('@/kernel/index.ts');
      resetDefaultsCache();
      const defaults = getDefaults();
      expect(defaults.tools.timeoutMs).toBe(120000);
    });
  });

  test('continues to later roots when a defaults.json file fails to load', async () => {
    await withTempCwd('defaults-invalid-json-continue', async (cwd) => {
      const localPluginsRoot = path.join(cwd, 'plugins');
      const externalA = path.join(cwd, 'packs', 'a');

      fs.mkdirSync(path.join(localPluginsRoot, 'configs'), { recursive: true });
      fs.mkdirSync(path.join(externalA, 'configs'), { recursive: true });

      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              plugins: './plugins',
              lookup: {
                configs: {
                  defaults: { builtin: false, local: true, externalRoots: ['./packs/a'] },
                  usageCosts: { builtin: false, local: false, externalRoots: [] }
                }
              }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(path.join(localPluginsRoot, 'configs', 'defaults.json'), '{ invalid json }', 'utf-8');

      fs.writeFileSync(
        path.join(externalA, 'configs', 'defaults.json'),
        JSON.stringify({ tools: { timeoutMs: 222 } }, null, 2),
        'utf-8'
      );

      const { getDefaults, resetDefaultsCache } = await import('@/kernel/index.ts');
      resetDefaultsCache();
      const defaults = getDefaults();
      expect(defaults.tools.timeoutMs).toBe(222);
    });
  });
});
