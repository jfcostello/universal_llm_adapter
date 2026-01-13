import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { ProviderManifest } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadProvidersInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  if (state.providersLoaded) return;

  if (state.mode === 'legacy') {
    const files = glob.sync('providers/*.json', { cwd: state.rootPath }).sort();
    for (const file of files) {
      if (options.strict) {
        const manifest = loadJsonFile(path.join(state.rootPath, file)) as ProviderManifest;
        state.providers.set(manifest.id, manifest);
        continue;
      }

      try {
        const manifest = loadJsonFile(path.join(state.rootPath, file)) as ProviderManifest;
        state.providers.set(manifest.id, manifest);
      } catch (error: any) {
        console.warn(`Skipping provider manifest ${file}: ${error.message}`);
      }
    }

    state.providersLoaded = true;
    return;
  }

  const roots = getPackRootsLowToHigh(state, 'providers', 'manifests');
  for (const root of roots) {
    const files = glob.sync('providers/*.json', { cwd: root.root }).sort();
    for (const file of files) {
      const fullPath = path.join(root.root, file);
      const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

      if (options.strict) {
        const manifest = loadJsonFile(fullPath) as ProviderManifest;
        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
        if (!id) {
          throw new ManifestError(`Invalid provider manifest '${fullPath}': missing id`);
        }

        const prev = getManifestSource(state, 'providers', id);
        if (prev) warnOnOverride(state, 'providers', id, prev, source);
        state.providers.set(id, manifest);
        setManifestSource(state, 'providers', id, source);
        continue;
      }

      try {
        const manifest = loadJsonFile(fullPath) as ProviderManifest;
        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
        if (!id) {
          console.warn(`Skipping provider manifest ${file}: missing id`);
          continue;
        }

        const prev = getManifestSource(state, 'providers', id);
        if (prev) warnOnOverride(state, 'providers', id, prev, source);
        state.providers.set(id, manifest);
        setManifestSource(state, 'providers', id, source);
      } catch (error: any) {
        console.warn(`Skipping provider manifest ${file}: ${error.message}`);
      }
    }
  }

  state.providersLoaded = true;
}

