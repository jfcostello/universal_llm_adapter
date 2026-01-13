import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { VectorStoreConfig } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadVectorStoresInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'vectorStoresLoaded', 'vector', async () => {
    await forEachManifestFile(
      state,
      { area: 'vector', pattern: 'vector/*.json', strict: options.strict, skipLabel: 'vector store manifest' },
      (file) => {
        const store = loadJsonFile(file.fullPath) as VectorStoreConfig;

        if (!file.isMultiRoot) {
          state.vectorStores.set(store.id, store);
          return;
        }

        const id = typeof (store as any)?.id === 'string' ? String((store as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid vector store manifest '${file.fullPath}': missing id`);
          }

          upsertManifestWithSource(state, 'vector', id, file.source, () => {
            state.vectorStores.set(id, store);
          });
          return;
        }

        if (!id) {
          console.warn(`Skipping vector store manifest ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'vector', id, file.source, () => {
          state.vectorStores.set(id, store);
        });
      }
    );
  });
}
