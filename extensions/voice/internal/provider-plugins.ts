import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { glob } from 'glob';
import { loadJsonFile, ManifestError, PACKAGE_ROOT } from '../../../kernel/index.js';

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

function getCompatRootCandidates(pluginsRoot: string): string[] {
  return [
    path.resolve(PACKAGE_ROOT, 'plugins', 'voice-compat'),
    path.join(pluginsRoot, 'voice-compat'),
    path.resolve(process.cwd(), 'plugins', 'voice-compat')
  ];
}

function resolveCompatEntry(pluginsRoot: string, kind: string): string | undefined {
  const candidates = getCompatRootCandidates(pluginsRoot);
  const visited = new Set<string>();

  for (const candidateRoot of candidates) {
    const root = path.resolve(candidateRoot);
    if (visited.has(root)) continue;
    visited.add(root);
    if (!fs.existsSync(root)) continue;

    const dir = path.join(root, kind);
    const dirIndexJs = path.join(dir, 'index.js');
    const dirIndexTs = path.join(dir, 'index.ts');
    if (fs.existsSync(dirIndexJs)) return dirIndexJs;
    if (fs.existsSync(dirIndexTs)) return dirIndexTs;

    const fileJs = path.join(root, `${kind}.js`);
    const fileTs = path.join(root, `${kind}.ts`);
    if (fs.existsSync(fileJs)) return fileJs;
    if (fs.existsSync(fileTs)) return fileTs;
  }

  return undefined;
}

function getDefaultOrFirstExport(imported: Record<string, any>): any {
  return imported.default ?? imported[Object.keys(imported)[0]];
}

export function createVoiceProviderPlugins(options: {
  pluginsPath: string;
  importModule?: (href: string) => Promise<any>;
}): VoiceProviderPlugins {
  const pluginsRoot = path.isAbsolute(options.pluginsPath)
    ? options.pluginsPath
    : path.resolve(process.cwd(), options.pluginsPath);

  const importModule = options.importModule ?? (async (href: string) => import(href));

  let manifestsLoaded = false;
  const manifests = new Map<string, VoiceProviderManifest>();
  const compatFactories = new Map<string, () => any>();

  const loadManifestsOnce = async () => {
    if (manifestsLoaded) return;
    manifestsLoaded = true;

    const files = glob.sync('voice-providers/*.json', { cwd: pluginsRoot });
    for (const rel of files) {
      const fullPath = path.join(pluginsRoot, rel);
      try {
        const raw = loadJsonFile(fullPath);
        const manifest = parseVoiceProviderManifest(raw, fullPath);

        if (manifests.has(manifest.id)) {
          throw new ManifestError(`Duplicate voice provider id '${manifest.id}'`);
        }
        manifests.set(manifest.id, manifest);
      } catch (err: any) {
        console.warn(`Skipping voice provider manifest ${rel}: ${String(err)}`);
      }
    }
  };

  const ensureCompatLoaded = async (kind: string): Promise<void> => {
    if (compatFactories.has(kind)) return;

    const safeKind = assertSafeName('compat kind', kind);
    const modulePath = resolveCompatEntry(pluginsRoot, safeKind);
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
      console.warn(`Failed to load voice compat module ${safeKind}: ${String(err)}`);
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
