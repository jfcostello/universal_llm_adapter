import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { RealtimeProviderManifest } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadRealtimeProvidersInternal(
  state: PluginRegistryState,
  options: { strict?: boolean } = {}
): Promise<void> {
  return runLoaderOnce(state, 'realtimeProvidersLoaded', 'realtime-providers', async () => {
    await forEachManifestFile(
      state,
      {
        area: 'realtime-providers',
        pattern: 'realtime-providers/*.json',
        strict: options.strict,
        skipLabel: 'realtime provider manifest'
      },
      (file) => {
        const manifest = loadJsonFile(file.fullPath) as RealtimeProviderManifest;

        if (!file.isMultiRoot) {
          state.realtimeProviders.set(manifest.id, manifest);
          return;
        }

        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid realtime provider manifest '${file.fullPath}': missing id`);
          }

          upsertManifestWithSource(state, 'realtime-providers', id, file.source, () => {
            state.realtimeProviders.set(id, manifest);
          });
          return;
        }

        if (!id) {
          console.warn(`Skipping realtime provider manifest ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'realtime-providers', id, file.source, () => {
          state.realtimeProviders.set(id, manifest);
        });
      }
    );
  });
}
