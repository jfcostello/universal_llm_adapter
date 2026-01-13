import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { EmbeddingProviderConfig } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadEmbeddingProvidersInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'embeddingProvidersLoaded', 'embeddings', async () => {
    await forEachManifestFile(
      state,
      {
        area: 'embeddings',
        pattern: 'embeddings/*.json',
        strict: options.strict,
        skipLabel: 'embedding provider config'
      },
      (file) => {
        const config = loadJsonFile(file.fullPath) as EmbeddingProviderConfig;

        if (!file.isMultiRoot) {
          state.embeddingProviders.set(config.id, config);
          return;
        }

        const id = typeof (config as any)?.id === 'string' ? String((config as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid embedding provider config '${file.fullPath}': missing id`);
          }

          upsertManifestWithSource(state, 'embeddings', id, file.source, () => {
            state.embeddingProviders.set(id, config);
          });
          return;
        }

        if (!id) {
          console.warn(`Skipping embedding provider config ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'embeddings', id, file.source, () => {
          state.embeddingProviders.set(id, config);
        });
      }
    );
  });
}
