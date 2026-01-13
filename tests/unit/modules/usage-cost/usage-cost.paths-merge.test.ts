import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('modules/usage-cost adapter paths merge', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('merges usage-costs.json across configured roots and warns on override when enabled', async () => {
    await withTempCwd('usage-costs-overlay-merge', async (cwd) => {
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
                warnOnOverride: true,
                configs: {
                  defaults: { builtin: false, local: false, externalRoots: [] },
                  usageCosts: { builtin: false, local: true, externalRoots: ['./packs/a', './packs/b'] }
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
        path.join(localPluginsRoot, 'configs', 'usage-costs.json'),
        JSON.stringify(
          {
            providerA: { modelX: { input: 1, output: 2 } },
            providerB: { modelY: { input: 3, output: 4 } }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(externalA, 'configs', 'usage-costs.json'),
        JSON.stringify(
          {
            providerA: {
              modelX: { input: 10, output: 20 },
              modelZ: { input: 5, output: 6 }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(externalB, 'configs', 'usage-costs.json'),
        JSON.stringify(
          {
            providerA: { modelX: { input: 100, output: 200 } }
          },
          null,
          2
        ),
        'utf-8'
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { loadUsageCostTable, resetUsageCostTableCache } = await import('@/modules/usage-cost/index.ts');
      resetUsageCostTableCache();
      const table = loadUsageCostTable();

      expect(table).toEqual({
        providerA: {
          modelX: { input: 100, output: 200 },
          modelZ: { input: 5, output: 6 }
        },
        providerB: {
          modelY: { input: 3, output: 4 }
        }
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'usage_costs.override',
        expect.objectContaining({ provider: 'providerA', model: 'modelX' })
      );
      expect(warnSpy.mock.calls.filter(call => call[0] === 'usage_costs.override')).toHaveLength(2);

      warnSpy.mockRestore();
    });
  });

  test('returns undefined when enabled but no valid cost table objects load', async () => {
    await withTempCwd('usage-costs-empty', async (cwd) => {
      const localPluginsRoot = path.join(cwd, 'plugins');
      fs.mkdirSync(path.join(localPluginsRoot, 'configs'), { recursive: true });

      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              lookup: {
                warnOnOverride: false,
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

      fs.writeFileSync(path.join(localPluginsRoot, 'configs', 'usage-costs.json'), JSON.stringify([], null, 2), 'utf-8');

      const { loadUsageCostTable, resetUsageCostTableCache } = await import('@/modules/usage-cost/index.ts');
      resetUsageCostTableCache();
      expect(loadUsageCostTable()).toBeUndefined();
    });
  });

  test('skips invalid provider/model entries and keeps valid ones', async () => {
    await withTempCwd('usage-costs-invalid-shapes', async (cwd) => {
      const localPluginsRoot = path.join(cwd, 'plugins');
      fs.mkdirSync(path.join(localPluginsRoot, 'configs'), { recursive: true });

      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              plugins: './plugins',
              lookup: {
                warnOnOverride: false,
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
        path.join(localPluginsRoot, 'configs', 'usage-costs.json'),
        JSON.stringify(
          {
            providerBad: 'nope',
            providerGood: {
              modelBad: true,
              modelGood: { input: 1, output: 2 }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      const { loadUsageCostTable, resetUsageCostTableCache } = await import('@/modules/usage-cost/index.ts');
      resetUsageCostTableCache();
      const table = loadUsageCostTable();

      expect(table).toEqual({
        providerGood: {
          modelGood: { input: 1, output: 2 }
        }
      });
    });
  });
});
