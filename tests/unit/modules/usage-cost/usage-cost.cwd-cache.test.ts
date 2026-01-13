import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('modules/usage-cost cwd-aware caching', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('loadUsageCostTable invalidates cache when cwd changes', async () => {
    const { loadUsageCostTable, resetUsageCostTableCache } = await import('@/modules/usage-cost/index.ts');
    resetUsageCostTableCache();

    await withTempCwd('usage-cost-cwd-cache-a', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'plugins', 'configs'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              lookup: {
                configs: {
                  defaults: { builtin: false, local: false, externalRoots: [] },
                  usageCosts: { builtin: false, local: true, externalRoots: [] }
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
        path.join(cwd, 'plugins', 'configs', 'usage-costs.json'),
        JSON.stringify({ providerA: { modelX: { input: 1, output: 2 } } }, null, 2),
        'utf-8'
      );

      const table = loadUsageCostTable();
      expect((table as any)?.providerA?.modelX?.input).toBe(1);
    });

    await withTempCwd('usage-cost-cwd-cache-b', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'plugins', 'configs'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              lookup: {
                configs: {
                  defaults: { builtin: false, local: false, externalRoots: [] },
                  usageCosts: { builtin: false, local: true, externalRoots: [] }
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
        path.join(cwd, 'plugins', 'configs', 'usage-costs.json'),
        JSON.stringify({ providerA: { modelX: { input: 9, output: 8 } } }, null, 2),
        'utf-8'
      );

      const table = loadUsageCostTable();
      expect((table as any)?.providerA?.modelX?.input).toBe(9);
    });
  });
});

