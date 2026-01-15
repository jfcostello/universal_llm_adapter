import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { glob } from 'glob';
import { loadJsonFile, ManifestError } from '../../../../../kernel/index.js';
import { emitManifestOverrideWarning } from '../../../../../modules/shared/index.js';
import { VOICE_EXTENSION_PLUGIN_ROOTS } from '../../shared/index.js';
import { resolveModuleEntryAcrossRoots } from './resolve-module-entry.js';

export interface VoiceProviderManifest {
  id: string;
  kind: string;
  defaults?: Record<string, any>;
}

export interface VoiceProviderPlugins {
  listManifests: () => Promise<VoiceProviderManifest[]>;
  getManifest: (id: string) => Promise<VoiceProviderManifest>;
  getCompat: (providerId: string) => Promise<any>;
}

function assertSafeName(label: string, value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new ManifestError(`Invalid voice ${label}: empty`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
    throw new ManifestError(`Invalid voice ${label}: '${raw}'`);
  }
  if (raw === '.' || raw === '..') {
    throw new ManifestError(`Invalid voice ${label}: '${raw}'`);
  }
  return raw;
}

function parseVoiceProviderManifest(value: any, filePath: string): VoiceProviderManifest {
  if (!value || typeof value !== 'object') {
    throw new ManifestError(`Invalid voice provider manifest '${filePath}': expected object`);
  }

  const id = assertSafeName('provider id', (value as any).id);
  const kind = assertSafeName('compat kind', (value as any).kind);

  const defaultsRaw = (value as any).defaults;
  const defaults = defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
    ? (defaultsRaw as Record<string, any>)
    : undefined;

  return { id, kind, ...(defaults ? { defaults } : {}) };
}

function getDefaultOrFirstExport(imported: Record<string, any>): any {
  return imported.default ?? imported[Object.keys(imported)[0]];
}

/**
 * Normalize plugin roots from options.
 * Handles both single path (legacy) and array of paths.
 */
function normalizePluginRoots(pluginRoots?: string | string[]): string[] {
  if (!pluginRoots) {
    return VOICE_EXTENSION_PLUGIN_ROOTS;
  }

  // Handle single path (legacy support for pluginsPath option passed through)
  if (typeof pluginRoots === 'string') {
    const trimmed = pluginRoots.trim();
    if (!trimmed) {
      return VOICE_EXTENSION_PLUGIN_ROOTS;
    }
    const resolved = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(process.cwd(), trimmed);
    return [resolved];
  }

  // Handle array of paths
  if (pluginRoots.length === 0) {
    return VOICE_EXTENSION_PLUGIN_ROOTS;
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of pluginRoots) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;

    const resolved = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(process.cwd(), trimmed);

    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }

  return out.length > 0 ? out : VOICE_EXTENSION_PLUGIN_ROOTS;
}

export function createVoiceProviderPlugins(options: {
  pluginRoots?: string | string[];
  importModule?: (href: string) => Promise<any>;
  logger?: { warning?: (message: string, data?: any) => void };
}): VoiceProviderPlugins {
  const pluginRoots = normalizePluginRoots(options.pluginRoots);

  const importModule = options.importModule ?? (async (href: string) => import(href));
  const safeWarn = (message: string, data?: any) => {
    try {
      const fn = options.logger?.warning;
      if (typeof fn === 'function') {
        fn(message, data);
        return;
      }
    } catch {}

    try {
      console.warn(message, data);
    } catch {}
  };

  let manifestsLoaded = false;
  const manifests = new Map<string, VoiceProviderManifest>();
  const manifestSources = new Map<string, string>(); // id -> filePath for override warnings
  const compatFactories = new Map<string, () => any>();

  const loadManifestsOnce = async () => {
    if (manifestsLoaded) return;
    manifestsLoaded = true;

    // Search for manifests across all plugin roots and combine them
    // Plugin roots are ordered high -> low precedence, so we load manifests low -> high.
    // Later (higher-precedence) roots override earlier roots.
    for (let i = pluginRoots.length - 1; i >= 0; i--) {
      const pluginsRoot = pluginRoots[i]!;
      if (!fs.existsSync(pluginsRoot)) continue;

      const files = glob.sync('providers/*.json', { cwd: pluginsRoot }).sort();
      for (const rel of files) {
        const fullPath = path.join(pluginsRoot, rel);
        try {
          const raw = loadJsonFile(fullPath);
          const manifest = parseVoiceProviderManifest(raw, fullPath);

          // Warn on override (same pattern as core registry)
          const previousSource = manifestSources.get(manifest.id);
          if (previousSource) {
            emitManifestOverrideWarning(safeWarn, 'voice.provider_plugins', manifest.id, previousSource, fullPath);
          }

          manifests.set(manifest.id, manifest);
          manifestSources.set(manifest.id, fullPath);
        } catch (err: any) {
          safeWarn('voice.provider_plugins.manifest_skipped', { manifestPath: fullPath, error: String(err) });
        }
      }
    }
  };

  const ensureCompatLoaded = async (kind: string): Promise<void> => {
    if (compatFactories.has(kind)) return;

    const safeKind = assertSafeName('compat kind', kind);
    const modulePath = resolveModuleEntryAcrossRoots(pluginRoots, 'compat', safeKind);
    if (!modulePath) {
      throw new ManifestError(`No voice compat module found for '${safeKind}'`);
    }

    try {
      const imported = await importModule(pathToFileURL(modulePath).href);
      const CompatClass = getDefaultOrFirstExport(imported as any);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      compatFactories.set(safeKind, () => new (CompatClass as any)());
    } catch (err: any) {
      safeWarn('voice.provider_plugins.compat_load_failed', { kind: safeKind, error: String(err) });
      throw new ManifestError(`No voice compat module found for '${safeKind}'`);
    }
  };

  return {
    listManifests: async () => {
      await loadManifestsOnce();
      return Array.from(manifests.values());
    },
    getManifest: async (id: string) => {
      await loadManifestsOnce();
      const safeId = assertSafeName('provider id', id);
      const manifest = manifests.get(safeId);
      if (!manifest) {
        throw new ManifestError(`Unknown voice provider '${safeId}'`);
      }
      return manifest;
    },
    getCompat: async (providerId: string) => {
      const manifest = await (async () => {
        await loadManifestsOnce();
        const safeId = assertSafeName('provider id', providerId);
        const m = manifests.get(safeId);
        if (!m) throw new ManifestError(`Unknown voice provider '${safeId}'`);
        return m;
      })();

      await ensureCompatLoaded(manifest.kind);
      return compatFactories.get(manifest.kind)!();
    }
  };
}
