import http from 'http';
import { jest } from '@jest/globals';

import { loadServerExtensions } from '@/modules/server/internal/extensions/host.ts';

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

  test('throws when an extension module does not export a default extension object', async () => {
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

  test('throws when an extension name does not match its folder name', async () => {
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

  test('skips extensions without registerServer', async () => {
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

  test('registers upgrade handlers and calls close hooks', async () => {
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

  test('close swallows unregister errors', async () => {
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

  test('throws when an extension is missing its name field', async () => {
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
});
