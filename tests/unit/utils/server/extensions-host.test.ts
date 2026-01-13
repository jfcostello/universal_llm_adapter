import http from 'http';
import fs from 'fs';
import { jest } from '@jest/globals';
import path from 'path';

import { loadServerExtensions } from '@/modules/server/internal/extensions/host.ts';
import { withTempCwd, writeJson } from '@tests/helpers/temp-files.ts';

function setupExternalExtensions(cwd: string, names: string[], options?: { defaultsByName?: Record<string, any> }): void {
  const packRoot = path.join(cwd, 'pack-a');

  for (const name of names) {
    fs.mkdirSync(path.join(packRoot, 'extensions', name), { recursive: true });
    fs.writeFileSync(path.join(packRoot, 'extensions', name, 'index.js'), `export default { name: '${name}' };`, 'utf-8');

    const defaults = options?.defaultsByName?.[name];
    if (defaults !== undefined) {
      fs.writeFileSync(
        path.join(packRoot, 'extensions', name, 'defaults.json'),
        JSON.stringify(defaults, null, 2),
        'utf-8'
      );
    }
  }

  writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
    paths: {
      lookup: {
        extensions: { builtin: false, externalRoots: ['./pack-a'] }
      }
    }
  });
}

describe('server/internal/extensions/host', () => {
  test('rejects invalid extension names', async () => {
    const server = http.createServer();
    await expect(loadServerExtensions({
      enabled: ['../evil'],
      server,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: { register: () => () => {}, close: () => {} }
    })).rejects.toThrow('Invalid extension name');
  });

  test('rejects empty extension name', async () => {
    const server = http.createServer();
    await expect(loadServerExtensions({
      enabled: [' '],
      server,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: { register: () => () => {}, close: () => {} }
    })).rejects.toThrow('Invalid extension name: empty');
  });

  test('rejects non-string extension names', async () => {
    const server = http.createServer();
    await expect(loadServerExtensions({
      enabled: [123] as any,
      server,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: { register: () => () => {}, close: () => {} }
    } as any)).rejects.toThrow('Invalid extension name: empty');
  });

  test('loads extensions and dispatches handleHttp', async () => {
    await withTempCwd('server-extensions-handle-http', async (cwd) => {
      setupExternalExtensions(cwd, ['a', 'b']);

      const server = http.createServer();
      const register = jest.fn(() => () => {});

      const importExtension = jest.fn(async (specifier: string) => {
        if (specifier.includes('/extensions/a/index.js')) {
          return {
            default: {
              name: 'a',
              registerServer: () => ({
                handleHttp: () => false
              })
            }
          };
        }
        if (specifier.includes('/extensions/b/index.js')) {
          return {
            default: {
              name: 'b',
              registerServer: () => ({
                handleHttp: () => true
              })
            }
          };
        }
        throw new Error(`Unexpected import: ${specifier}`);
      });

      const host = await loadServerExtensions({
        enabled: ['a', 'b'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register, close: () => {} },
        importExtension
      });

      const handled = await host.handleHttp({} as any, {} as any);
      expect(handled).toBe(true);
      expect(importExtension).toHaveBeenCalledTimes(2);
    });
  });

  test('throws when an extension module does not export a default extension object', async () => {
    await withTempCwd('server-extensions-missing-default', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();
      await expect(loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        importExtension: async () => ({})
      })).rejects.toThrow("did not export a default extension object");
    });
  });

  test('throws when an extension name does not match its folder name', async () => {
    await withTempCwd('server-extensions-name-mismatch', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();
      await expect(loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        importExtension: async () => ({
          default: { name: 'b', registerServer: async () => ({}) }
        })
      })).rejects.toThrow('Extension name mismatch');
    });
  });

  test('skips extensions without registerServer', async () => {
    await withTempCwd('server-extensions-skip-no-register', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();

      const host = await loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        importExtension: async () => ({
          default: { name: 'a' }
        })
      });

      await expect(host.handleHttp({} as any, {} as any)).resolves.toBe(false);
      await expect(host.close()).resolves.toBeUndefined();
    });
  });

  test('registers upgrade handlers and calls close hooks', async () => {
    await withTempCwd('server-extensions-upgrade-close', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();
      const unregister = jest.fn();
      const register = jest.fn(() => unregister);
      const close = jest.fn().mockResolvedValue(undefined);

      const importExtension = jest.fn(async () => ({
        default: {
          name: 'a',
          registerServer: () => ({
            handleUpgrade: async () => true,
            close
          })
        }
      }));

      const host = await loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register, close: () => {} },
        importExtension
      });

      await host.close();
      expect(register).toHaveBeenCalledTimes(1);
      expect(unregister).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  test('close swallows unregister errors', async () => {
    await withTempCwd('server-extensions-close-swallow', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();
      const unregister = jest.fn(() => {
        throw new Error('boom');
      });
      const close = jest.fn().mockResolvedValue(undefined);

      const host = await loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => unregister, close: () => {} },
        importExtension: async () => ({
          default: {
            name: 'a',
            registerServer: () => ({
              handleUpgrade: async () => true,
              close
            })
          }
        })
      });

      await expect(host.close()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  test('throws when an extension is missing its name field', async () => {
    await withTempCwd('server-extensions-missing-name', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();
      await expect(loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        importExtension: async () => ({
          default: { registerServer: async () => ({}) }
        })
      })).rejects.toThrow('missing required name');
    });
  });

  test('treats non-array enabled as empty', async () => {
    const server = http.createServer();
    const importExtension = jest.fn();

    const host = await loadServerExtensions({
      enabled: 'voice' as any,
      server,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: { register: () => () => {}, close: () => {} },
      importExtension
    } as any);

    await expect(host.handleHttp({} as any, {} as any)).resolves.toBe(false);
    expect(importExtension).not.toHaveBeenCalled();
  });

  test('passes httpConfig into extension registerServer context', async () => {
    await withTempCwd('server-extensions-http-config', async (cwd) => {
      setupExternalExtensions(cwd, ['a']);

      const server = http.createServer();
      const register = jest.fn(() => () => {});
      const registerServer = jest.fn(() => ({}));

      const importExtension = jest.fn(async () => ({
        default: { name: 'a', registerServer }
      }));

      await loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register, close: () => {} },
        httpConfig: { auth: { enabled: true }, rateLimit: { enabled: false } },
        importExtension
      } as any);

      expect(registerServer).toHaveBeenCalledTimes(1);
      const ctx = registerServer.mock.calls[0][0];
      expect(ctx.httpConfig).toEqual({ auth: { enabled: true }, rateLimit: { enabled: false } });
    });
  });

  test('throws when an enabled extension cannot be resolved', async () => {
    await withTempCwd('server-extensions-missing', async (cwd) => {
      fs.mkdirSync(path.join(cwd, 'pack-a'), { recursive: true });
      writeJson(path.join(cwd, 'llm-adapter.paths.json'), {
        paths: {
          lookup: {
            extensions: { builtin: false, externalRoots: ['./pack-a'] }
          }
        }
      });

      const server = http.createServer();
      await expect(loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} }
      })).rejects.toThrow('could not be resolved');
    });
  });

  test('merges extension defaults.json with legacy httpConfig.extensions config', async () => {
    await withTempCwd('server-extensions-defaults-merge', async (cwd) => {
      setupExternalExtensions(cwd, ['a'], {
        defaultsByName: {
          a: { foo: 1, nested: { a: 1, arr: [1, 2] } }
        }
      });

      const server = http.createServer();
      const registerServer = jest.fn(() => ({}));
      const importExtension = jest.fn(async () => ({
        default: { name: 'a', registerServer }
      }));

      await loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        httpConfig: { extensions: { a: { foo: 2, nested: { b: 2, arr: [3] } } } },
        importExtension
      } as any);

      const ctx = registerServer.mock.calls[0][0];
      expect(ctx.httpConfig.extensions.a).toEqual({
        foo: 2,
        nested: { a: 1, b: 2, arr: [3] }
      });
    });
  });

  test('injects defaults.json into httpConfig.extensions when httpConfig has no extensions field', async () => {
    await withTempCwd('server-extensions-defaults-no-extensions-field', async (cwd) => {
      setupExternalExtensions(cwd, ['a'], { defaultsByName: { a: { foo: 1 } } });

      const server = http.createServer();
      const registerServer = jest.fn(() => ({}));
      const importExtension = jest.fn(async () => ({
        default: { name: 'a', registerServer }
      }));

      await loadServerExtensions({
        enabled: ['a'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        httpConfig: { auth: { enabled: true } },
        importExtension
      } as any);

      const ctx = registerServer.mock.calls[0][0];
      expect(ctx.httpConfig.extensions.a).toEqual({ foo: 1 });
    });
  });

  test('imports builtin extensions using the relative specifier when no paths config exists', async () => {
    await withTempCwd('server-extensions-builtin', async () => {
      const server = http.createServer();

      const importExtension = jest.fn(async (specifier: string) => ({
        default: {
          name: 'voice',
          registerServer: async () => ({})
        }
      }));

      await loadServerExtensions({
        enabled: ['voice'],
        server,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: { register: () => () => {}, close: () => {} },
        importExtension
      });

      expect(importExtension).toHaveBeenCalledTimes(1);
      expect(String(importExtension.mock.calls[0]![0])).toContain('/extensions/voice/index.js');
    });
  });
});
