import type http from 'http';
import { pathToFileURL } from 'url';

import { assertValidExtensionName } from '../../../shared/index.js';
import { loadExtensionDefaults, mergeExtensionConfig, resolveExtensionEntry } from '../../../extensions/index.js';
import type {
  UpgradeHandler,
  UpgradeRouter
} from '../transport/upgrade-router.js';

export interface ServerExtensionContext {
  server: http.Server;
  registry: any;
  pluginsPath: string;
  upgradeRouter: UpgradeRouter;
  httpConfig?: any;
}

export interface ServerExtensionRegistration {
  handleHttp?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;
  handleUpgrade?: UpgradeHandler;
  close?: () => Promise<void>;
}

export interface ServerExtensionModule {
  name: string;
  registerServer?: (
    ctx: ServerExtensionContext
  ) => ServerExtensionRegistration | Promise<ServerExtensionRegistration>;
}

export async function loadServerExtensions(options: {
  enabled: string[];
  server: http.Server;
  registry: any;
  pluginsPath: string;
  upgradeRouter: UpgradeRouter;
  httpConfig?: any;
  importExtension?: (specifier: string) => Promise<any>;
}): Promise<{
  handleHttp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  close: () => Promise<void>;
}> {
  const enabled = Array.isArray(options.enabled) ? options.enabled : [];
  const importExtension =
    options.importExtension ?? ((specifier: string) => import(specifier));

  const httpHandlers: Array<NonNullable<ServerExtensionRegistration['handleHttp']>> = [];
  const unregisterUpgradeHandlers: Array<() => void> = [];
  const closeHandlers: Array<NonNullable<ServerExtensionRegistration['close']>> = [];

  for (const extRaw of enabled) {
    const name = assertValidExtensionName(extRaw);
    const resolved = resolveExtensionEntry(name);
    if (!resolved) {
      throw new Error(`Enabled extension '${name}' could not be resolved`);
    }

    const importSpecifier =
      resolved.kind === 'builtin'
        ? `../../../../extensions/${name}/index.js`
        : pathToFileURL(resolved.entryFilePath).href;

    const mod = await importExtension(importSpecifier);
    const ext: ServerExtensionModule | undefined = (mod as any)?.default;
    if (!ext || typeof ext !== 'object') {
      throw new Error(`Extension '${name}' did not export a default extension object`);
    }
    if (typeof (ext as any).name !== 'string') {
      throw new Error(`Extension '${name}' missing required name`);
    }
    if ((ext as any).name !== name) {
      throw new Error(`Extension name mismatch: expected '${name}', got '${(ext as any).name}'`);
    }

    const registerServer = (ext as any).registerServer as ServerExtensionModule['registerServer'] | undefined;
    if (typeof registerServer !== 'function') continue;

    const defaultsConfig = loadExtensionDefaults(resolved);
    const legacyConfig = options.httpConfig?.extensions?.[name];
    const mergedConfig = mergeExtensionConfig(defaultsConfig, legacyConfig);
    const mergedHttpConfig =
      options.httpConfig && mergedConfig !== undefined
        ? {
            ...options.httpConfig,
            extensions: {
              ...(options.httpConfig.extensions ?? {}),
              [name]: mergedConfig
            }
          }
        : options.httpConfig;

    const registration = await registerServer({
      server: options.server,
      registry: options.registry,
      pluginsPath: options.pluginsPath,
      upgradeRouter: options.upgradeRouter,
      httpConfig: mergedHttpConfig
    });

    if (registration.handleHttp) {
      httpHandlers.push(registration.handleHttp);
    }

    if (registration.handleUpgrade) {
      const unregister = options.upgradeRouter.register(registration.handleUpgrade);
      unregisterUpgradeHandlers.push(unregister);
    }

    if (registration.close) {
      closeHandlers.push(registration.close);
    }
  }

  return {
    handleHttp: async (req, res) => {
      for (const handler of httpHandlers) {
        const handled = await handler(req, res);
        if (handled) return true;
      }
      return false;
    },
    close: async () => {
      for (const unregister of unregisterUpgradeHandlers) {
        try {
          unregister();
        } catch {}
      }
      for (const close of closeHandlers) {
        await close();
      }
    }
  };
}
