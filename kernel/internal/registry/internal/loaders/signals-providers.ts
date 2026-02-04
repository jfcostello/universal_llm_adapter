import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { SignalsProviderManifest } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadSignalsProvidersInternal(
  state: PluginRegistryState,
  options: { strict?: boolean } = {}
): Promise<void> {
  return runLoaderOnce(state, 'signalsProvidersLoaded', 'signals-providers', async () => {
    await forEachManifestFile(
      state,
      {
        area: 'signals-providers',
        pattern: 'signals-providers/*.json',
        strict: options.strict,
        skipLabel: 'signals provider manifest'
      },
      (file) => {
        const manifest = loadJsonFile(file.fullPath) as SignalsProviderManifest;

        if (!file.isMultiRoot) {
          state.signalsProviders.set(manifest.id, manifest);
          return;
        }

        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid signals provider manifest '${file.fullPath}': missing id`);
          }

          upsertManifestWithSource(state, 'signals-providers', id, file.source, () => {
            state.signalsProviders.set(id, manifest);
          });
          return;
        }

        if (!id) {
          console.warn(`Skipping signals provider manifest ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'signals-providers', id, file.source, () => {
          state.signalsProviders.set(id, manifest);
        });
      }
    );
  });
}

