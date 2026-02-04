import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { resolveModuleEntryInRoot } from '../../fs-module-entry.js';
import { PACKAGE_ROOT } from '../../paths.js';
import { ManifestError } from '../../errors.js';

import type { IRealtimeCompat } from '../../realtime-types.js';
import type {
  ICompatModule,
  IEmbeddingCompat,
  IObservabilityCompat,
  ISignalsCompat,
  IVectorStoreCompat
} from '../../types.js';

import type { PluginRegistrySourceKind } from './public-types.js';
import type { PluginRegistryState } from './state.js';
import { getPackRootsLowToHigh } from './lookup.js';
import { runCodeModuleLoadOnce } from './loader-lock.js';

const distRoot = PACKAGE_ROOT;

export function getPluginCodeCandidates(
  state: PluginRegistryState,
  area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat' | 'signals-compat'
): string[] {
  return [
    path.resolve(distRoot, 'plugins', area),
    path.join(state.rootPath, area),
    path.resolve(process.cwd(), 'plugins', area)
  ];
}

export function resolvePluginCodeEntry(
  state: PluginRegistryState,
  area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat' | 'signals-compat',
  moduleName: string
): string | undefined {
  const candidates = getPluginCodeCandidates(state, area);
  const visited = new Set<string>();

  for (const candidateRoot of candidates) {
    const root = path.resolve(candidateRoot);
    if (visited.has(root)) continue;
    visited.add(root);

    if (!fs.existsSync(root)) continue;

    const found = resolveModuleEntryInRoot(root, moduleName);
    if (found) return found;
  }

  return undefined;
}

export function resolvePluginCodeEntryMultiRoot(
  state: PluginRegistryState,
  area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat' | 'signals-compat',
  moduleName: string,
  preferredPackRoot?: string
): { modulePath: string; key: string } | undefined {
  const rootsHighToLow = getPackRootsLowToHigh(state, area, 'code').slice().reverse();
  const preferred = preferredPackRoot && path.isAbsolute(preferredPackRoot)
    ? preferredPackRoot
    : preferredPackRoot
      ? path.resolve(process.cwd(), preferredPackRoot)
      : undefined;

  const keyForRoot = (root: string) => `${moduleName}@@${root}`;
  const preferredAllowed = preferred ? rootsHighToLow.some(r => r.root === preferred) : false;

  // Prefer-same-root binding: if the manifest root has the module, use it even if other roots have it.
  if (preferred && preferredAllowed) {
    const preferredRoot = path.join(preferred, area);
    if (fs.existsSync(preferredRoot)) {
      const preferredEntry = resolveModuleEntryInRoot(preferredRoot, moduleName);
      if (preferredEntry) {
        if (state.lookup?.warnOnOverride) {
          const overridden: Array<{ root: string; kind: PluginRegistrySourceKind; precedence: number; modulePath: string }> = [];

          for (const root of rootsHighToLow) {
            if (root.root === preferred) continue;
            const codeRoot = path.join(root.root, area);
            if (!fs.existsSync(codeRoot)) continue;

            const found = resolveModuleEntryInRoot(codeRoot, moduleName);
            if (found) {
              overridden.push({ root: root.root, kind: root.kind, precedence: root.precedence, modulePath: found });
            }
          }

          if (overridden.length > 0) {
            const winner = rootsHighToLow.find(r => r.root === preferred)!;
            try {
              console.warn('plugin_registry.code_override', {
                area,
                moduleName,
                winner: { kind: winner.kind, root: winner.root, precedence: winner.precedence, modulePath: preferredEntry },
                overridden: overridden.map(h => ({ kind: h.kind, root: h.root, precedence: h.precedence, modulePath: h.modulePath }))
              });
            } catch {}
          }
        }

        return { modulePath: preferredEntry, key: keyForRoot(preferred) };
      }
    }
  }

  const hits: Array<{ root: string; kind: PluginRegistrySourceKind; precedence: number; modulePath: string }> = [];

  for (const root of rootsHighToLow) {
    const codeRoot = path.join(root.root, area);
    if (!fs.existsSync(codeRoot)) continue;

    const found = resolveModuleEntryInRoot(codeRoot, moduleName);
    if (found) {
      hits.push({ root: root.root, kind: root.kind, precedence: root.precedence, modulePath: found });
    }
  }

  const winner = hits[0];
  if (!winner) return undefined;

  if (state.lookup?.warnOnOverride && hits.length > 1) {
    try {
      console.warn('plugin_registry.code_override', {
        area,
        moduleName,
        winner: { kind: winner.kind, root: winner.root, precedence: winner.precedence, modulePath: winner.modulePath },
        overridden: hits.slice(1).map(h => ({ kind: h.kind, root: h.root, precedence: h.precedence, modulePath: h.modulePath }))
      });
    } catch {}
  }

  return { modulePath: winner.modulePath, key: keyForRoot(winner.root) };
}

export async function importPluginCodeModule(modulePath: string): Promise<any> {
  return import(pathToFileURL(modulePath).href);
}

export function getDefaultOrFirstExport(imported: Record<string, any>): any {
  return imported.default ?? imported[Object.keys(imported)[0]];
}

export function assertSafePluginModuleName(
  area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat' | 'signals-compat',
  moduleName: string
): void {
  // Module names come from manifests; harden against path traversal and invalid paths.
  // Allow only simple names like "example-compat" or "example_store".
  if (!/^[a-zA-Z0-9._-]+$/.test(moduleName)) {
    throw new ManifestError(`Invalid ${area} module name '${moduleName}'`);
  }
  if (moduleName === '.' || moduleName === '..' || moduleName.includes('..')) {
    throw new ManifestError(`Invalid ${area} module name '${moduleName}'`);
  }
}

export async function ensureCompatModuleLoaded(
  state: PluginRegistryState,
  moduleName: string,
  options: { preferredPackRoot?: string } = {}
): Promise<string> {
  state.compatModulesLoaded = true;
  assertSafePluginModuleName('compat', moduleName);

  const resolved = state.mode === 'multi-root'
    ? resolvePluginCodeEntryMultiRoot(state, 'compat', moduleName, options.preferredPackRoot)
    : (() => {
        const modulePath = resolvePluginCodeEntry(state, 'compat', moduleName);
        return modulePath ? { modulePath, key: moduleName } : undefined;
      })();

  if (!resolved) {
    throw new ManifestError(`No compat module found for '${moduleName}'`);
  }

  return runCodeModuleLoadOnce(state, state.compatModules, resolved.key, async () => {
    try {
      const imported = await importPluginCodeModule(resolved.modulePath);
      const CompatClass = getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      return () => new (CompatClass as any)();
    } catch (error: any) {
      console.warn(`Failed to load compat module ${moduleName}: ${error.message}`);
      throw new ManifestError(`No compat module found for '${moduleName}'`);
    }
  });
}

export async function ensureEmbeddingCompatLoaded(
  state: PluginRegistryState,
  kind: string,
  options: { preferredPackRoot?: string } = {}
): Promise<string> {
  state.embeddingCompatsLoaded = true;
  assertSafePluginModuleName('embedding-compat', kind);

  const resolved = state.mode === 'multi-root'
    ? resolvePluginCodeEntryMultiRoot(state, 'embedding-compat', kind, options.preferredPackRoot)
    : (() => {
        const modulePath = resolvePluginCodeEntry(state, 'embedding-compat', kind);
        return modulePath ? { modulePath, key: kind } : undefined;
      })();

  if (!resolved) {
    throw new ManifestError(`No embedding compat module found for '${kind}'`);
  }

  return runCodeModuleLoadOnce(state, state.embeddingCompats, resolved.key, async () => {
    try {
      const imported = await importPluginCodeModule(resolved.modulePath);
      const CompatClass = getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      return () => new (CompatClass as any)();
    } catch (error: any) {
      console.warn(`Failed to load embedding compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No embedding compat module found for '${kind}'`);
    }
  });
}

export async function ensureVectorStoreCompatLoaded(
  state: PluginRegistryState,
  kind: string,
  options: { preferredPackRoot?: string } = {}
): Promise<string> {
  state.vectorStoreCompatsLoaded = true;
  assertSafePluginModuleName('vector-compat', kind);

  const resolved = state.mode === 'multi-root'
    ? resolvePluginCodeEntryMultiRoot(state, 'vector-compat', kind, options.preferredPackRoot)
    : (() => {
        const modulePath = resolvePluginCodeEntry(state, 'vector-compat', kind);
        return modulePath ? { modulePath, key: kind } : undefined;
      })();

  if (!resolved) {
    throw new ManifestError(`No vector store compat module found for '${kind}'`);
  }

  return runCodeModuleLoadOnce(state, state.vectorStoreCompats, resolved.key, async () => {
    try {
      const imported = await importPluginCodeModule(resolved.modulePath);
      const CompatClass = getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        console.warn(`Failed to load vector store compat module ${kind}: module did not export a constructor`);
        throw new ManifestError(`No vector store compat module found for '${kind}'`);
      }
      return () => new (CompatClass as any)();
    } catch (error: any) {
      // If we already threw a ManifestError for non-constructors above, preserve that without duplicating warnings.
      if (error instanceof ManifestError) {
        throw error;
      }
      console.warn(`Failed to load vector store compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No vector store compat module found for '${kind}'`);
    }
  });
}

export async function ensureRealtimeCompatLoaded(
  state: PluginRegistryState,
  kind: string,
  options: { preferredPackRoot?: string } = {}
): Promise<string> {
  state.realtimeCompatsLoaded = true;
  assertSafePluginModuleName('realtime-compat', kind);

  const resolved = state.mode === 'multi-root'
    ? resolvePluginCodeEntryMultiRoot(state, 'realtime-compat', kind, options.preferredPackRoot)
    : (() => {
        const modulePath = resolvePluginCodeEntry(state, 'realtime-compat', kind);
        return modulePath ? { modulePath, key: kind } : undefined;
      })();

  if (!resolved) {
    throw new ManifestError(`No realtime compat module found for '${kind}'`);
  }

  return runCodeModuleLoadOnce(state, state.realtimeCompats, resolved.key, async () => {
    try {
      const imported = await importPluginCodeModule(resolved.modulePath);
      const CompatClass = getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      return () => new (CompatClass as any)() as IRealtimeCompat;
    } catch (error: any) {
      console.warn(`Failed to load realtime compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No realtime compat module found for '${kind}'`);
    }
  });
}

export async function ensureObservabilityCompatLoaded(
  state: PluginRegistryState,
  kind: string,
  options: { preferredPackRoot?: string } = {}
): Promise<string> {
  state.observabilityCompatsLoaded = true;
  assertSafePluginModuleName('observability-compat', kind);

  const resolved = state.mode === 'multi-root'
    ? resolvePluginCodeEntryMultiRoot(state, 'observability-compat', kind, options.preferredPackRoot)
    : (() => {
        const modulePath = resolvePluginCodeEntry(state, 'observability-compat', kind);
        return modulePath ? { modulePath, key: kind } : undefined;
      })();

  if (!resolved) {
    throw new ManifestError(`No observability compat module found for '${kind}'`);
  }

  return runCodeModuleLoadOnce(state, state.observabilityCompats, resolved.key, async () => {
    try {
      const imported = await importPluginCodeModule(resolved.modulePath);
      const CompatClass = getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      return () => new (CompatClass as any)() as IObservabilityCompat;
    } catch (error: any) {
      console.warn(`Failed to load observability compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No observability compat module found for '${kind}'`);
    }
  });
}

export async function ensureSignalsCompatLoaded(
  state: PluginRegistryState,
  kind: string,
  options: { preferredPackRoot?: string } = {}
): Promise<string> {
  state.signalsCompatsLoaded = true;
  assertSafePluginModuleName('signals-compat', kind);

  const resolved = state.mode === 'multi-root'
    ? resolvePluginCodeEntryMultiRoot(state, 'signals-compat', kind, options.preferredPackRoot)
    : (() => {
        const modulePath = resolvePluginCodeEntry(state, 'signals-compat', kind);
        return modulePath ? { modulePath, key: kind } : undefined;
      })();

  if (!resolved) {
    throw new ManifestError(`No signals compat module found for '${kind}'`);
  }

  return runCodeModuleLoadOnce(state, state.signalsCompats, resolved.key, async () => {
    try {
      const imported = await importPluginCodeModule(resolved.modulePath);
      const CompatClass = getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      return () => new (CompatClass as any)() as ISignalsCompat;
    } catch (error: any) {
      console.warn(`Failed to load signals compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No signals compat module found for '${kind}'`);
    }
  });
}
