import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { ObservabilityProviderManifest } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadObservabilityProvidersInternal(
  state: PluginRegistryState,
  options: { strict?: boolean } = {}
): Promise<void> {
  if (state.observabilityProvidersLoaded) return;

  if (state.mode === 'legacy') {
    const files = glob.sync('observability-providers/*.json', { cwd: state.rootPath }).sort();
    for (const file of files) {
      if (options.strict) {
        const manifest = loadJsonFile(path.join(state.rootPath, file)) as ObservabilityProviderManifest;
        state.observabilityProviders.set(manifest.id, manifest);
        continue;
      }

      try {
        const manifest = loadJsonFile(path.join(state.rootPath, file)) as ObservabilityProviderManifest;
        state.observabilityProviders.set(manifest.id, manifest);
      } catch (error: any) {
        console.warn(`Skipping observability provider manifest ${file}: ${error.message}`);
      }
    }

    state.observabilityProvidersLoaded = true;
    return;
  }

  const roots = getPackRootsLowToHigh(state, 'observability-providers', 'manifests');
  for (const root of roots) {
    const files = glob.sync('observability-providers/*.json', { cwd: root.root }).sort();
    for (const file of files) {
      const fullPath = path.join(root.root, file);
      const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

      if (options.strict) {
        const manifest = loadJsonFile(fullPath) as ObservabilityProviderManifest;
        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
        if (!id) {
          throw new ManifestError(`Invalid observability provider manifest '${fullPath}': missing id`);
        }

        const prev = getManifestSource(state, 'observability-providers', id);
        if (prev) warnOnOverride(state, 'observability-providers', id, prev, source);
        state.observabilityProviders.set(id, manifest);
        setManifestSource(state, 'observability-providers', id, source);
        continue;
      }

      try {
        const manifest = loadJsonFile(fullPath) as ObservabilityProviderManifest;
        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
        if (!id) {
          console.warn(`Skipping observability provider manifest ${file}: missing id`);
          continue;
        }

        const prev = getManifestSource(state, 'observability-providers', id);
        if (prev) warnOnOverride(state, 'observability-providers', id, prev, source);
        state.observabilityProviders.set(id, manifest);
        setManifestSource(state, 'observability-providers', id, source);
      } catch (error: any) {
        console.warn(`Skipping observability provider manifest ${file}: ${error.message}`);
      }
    }
  }

  state.observabilityProvidersLoaded = true;
}

