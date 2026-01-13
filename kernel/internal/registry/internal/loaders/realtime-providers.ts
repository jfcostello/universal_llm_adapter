import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { RealtimeProviderManifest } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadRealtimeProvidersInternal(
  state: PluginRegistryState,
  options: { strict?: boolean } = {}
): Promise<void> {
  if (state.realtimeProvidersLoaded) return;

  if (state.mode === 'legacy') {
    const files = glob.sync('realtime-providers/*.json', { cwd: state.rootPath }).sort();
    for (const file of files) {
      if (options.strict) {
        const manifest = loadJsonFile(path.join(state.rootPath, file)) as RealtimeProviderManifest;
        state.realtimeProviders.set(manifest.id, manifest);
        continue;
      }

      try {
        const manifest = loadJsonFile(path.join(state.rootPath, file)) as RealtimeProviderManifest;
        state.realtimeProviders.set(manifest.id, manifest);
      } catch (error: any) {
        console.warn(`Skipping realtime provider manifest ${file}: ${error.message}`);
      }
    }

    state.realtimeProvidersLoaded = true;
    return;
  }

  const roots = getPackRootsLowToHigh(state, 'realtime-providers', 'manifests');
  for (const root of roots) {
    const files = glob.sync('realtime-providers/*.json', { cwd: root.root }).sort();
    for (const file of files) {
      const fullPath = path.join(root.root, file);
      const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

      if (options.strict) {
        const manifest = loadJsonFile(fullPath) as RealtimeProviderManifest;
        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
        if (!id) {
          throw new ManifestError(`Invalid realtime provider manifest '${fullPath}': missing id`);
        }

        const prev = getManifestSource(state, 'realtime-providers', id);
        if (prev) warnOnOverride(state, 'realtime-providers', id, prev, source);
        state.realtimeProviders.set(id, manifest);
        setManifestSource(state, 'realtime-providers', id, source);
        continue;
      }

      try {
        const manifest = loadJsonFile(fullPath) as RealtimeProviderManifest;
        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
        if (!id) {
          console.warn(`Skipping realtime provider manifest ${file}: missing id`);
          continue;
        }

        const prev = getManifestSource(state, 'realtime-providers', id);
        if (prev) warnOnOverride(state, 'realtime-providers', id, prev, source);
        state.realtimeProviders.set(id, manifest);
        setManifestSource(state, 'realtime-providers', id, source);
      } catch (error: any) {
        console.warn(`Skipping realtime provider manifest ${file}: ${error.message}`);
      }
    }
  }

  state.realtimeProvidersLoaded = true;
}

