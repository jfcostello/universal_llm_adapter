import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { ObservabilityProviderManifest } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadObservabilityProvidersInternal(
  state: PluginRegistryState,
  options: { strict?: boolean } = {}
): Promise<void> {
  return runLoaderOnce(state, 'observabilityProvidersLoaded', 'observability-providers', async () => {
    await forEachManifestFile(
      state,
      {
        area: 'observability-providers',
        pattern: 'observability-providers/*.json',
        strict: options.strict,
        skipLabel: 'observability provider manifest'
      },
      (file) => {
        const manifest = loadJsonFile(file.fullPath) as ObservabilityProviderManifest;

        if (!file.isMultiRoot) {
          state.observabilityProviders.set(manifest.id, manifest);
          return;
        }

        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid observability provider manifest '${file.fullPath}': missing id`);
          }

          upsertManifestWithSource(state, 'observability-providers', id, file.source, () => {
            state.observabilityProviders.set(id, manifest);
          });
          return;
        }

        if (!id) {
          console.warn(`Skipping observability provider manifest ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'observability-providers', id, file.source, () => {
          state.observabilityProviders.set(id, manifest);
        });
      }
    );
  });
}
