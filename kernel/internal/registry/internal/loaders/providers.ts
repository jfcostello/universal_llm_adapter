import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { ProviderManifest } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadProvidersInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'providersLoaded', 'providers', async () => {
    await forEachManifestFile(
      state,
      { area: 'providers', pattern: 'providers/*.json', strict: options.strict, skipLabel: 'provider manifest' },
      (file) => {
        const manifest = loadJsonFile(file.fullPath) as ProviderManifest;

        if (!file.isMultiRoot) {
          state.providers.set(manifest.id, manifest);
          return;
        }

        const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid provider manifest '${file.fullPath}': missing id`);
          }

          upsertManifestWithSource(state, 'providers', id, file.source, () => {
            state.providers.set(id, manifest);
          });
          return;
        }

        if (!id) {
          console.warn(`Skipping provider manifest ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'providers', id, file.source, () => {
          state.providers.set(id, manifest);
        });
      }
    );
  });
}
