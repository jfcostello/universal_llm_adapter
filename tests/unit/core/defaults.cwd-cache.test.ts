import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('core/defaults cwd-aware caching', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('getDefaults invalidates cache when cwd changes', async () => {
    const { getDefaults, resetDefaultsCache } = await import('@/kernel/index.ts');
    resetDefaultsCache();

    await withTempCwd('defaults-cwd-cache-a', async (cwd) => {
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
        JSON.stringify({ tools: { timeoutMs: 111 } }, null, 2),
        'utf-8'
      );

      expect(getDefaults().tools.timeoutMs).toBe(111);
    });

    await withTempCwd('defaults-cwd-cache-b', async (cwd) => {
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
        JSON.stringify({ tools: { timeoutMs: 222 } }, null, 2),
        'utf-8'
      );

      expect(getDefaults().tools.timeoutMs).toBe(222);
    });
  });
});

