import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { EmbeddingProviderConfig } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadEmbeddingProvidersInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'embeddingProvidersLoaded', 'embeddings', async () => {
    if (state.mode === 'legacy') {
      const files = glob.sync('embeddings/*.json', { cwd: state.rootPath }).sort();
      for (const file of files) {
        if (options.strict) {
          const config = loadJsonFile(path.join(state.rootPath, file)) as EmbeddingProviderConfig;
          state.embeddingProviders.set(config.id, config);
          continue;
        }

        try {
          const config = loadJsonFile(path.join(state.rootPath, file)) as EmbeddingProviderConfig;
          state.embeddingProviders.set(config.id, config);
        } catch (error: any) {
          console.warn(`Skipping embedding provider config ${file}: ${error.message}`);
        }
      }

      return;
    }

    const roots = getPackRootsLowToHigh(state, 'embeddings', 'manifests');
    for (const root of roots) {
      const files = glob.sync('embeddings/*.json', { cwd: root.root }).sort();
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const config = loadJsonFile(fullPath) as EmbeddingProviderConfig;
          const id = typeof (config as any)?.id === 'string' ? String((config as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid embedding provider config '${fullPath}': missing id`);
          }

          const prev = getManifestSource(state, 'embeddings', id);
          if (prev) warnOnOverride(state, 'embeddings', id, prev, source);
          state.embeddingProviders.set(id, config);
          setManifestSource(state, 'embeddings', id, source);
          continue;
        }

        try {
          const config = loadJsonFile(fullPath) as EmbeddingProviderConfig;
          const id = typeof (config as any)?.id === 'string' ? String((config as any).id) : '';
          if (!id) {
            console.warn(`Skipping embedding provider config ${file}: missing id`);
            continue;
          }

          const prev = getManifestSource(state, 'embeddings', id);
          if (prev) warnOnOverride(state, 'embeddings', id, prev, source);
          state.embeddingProviders.set(id, config);
          setManifestSource(state, 'embeddings', id, source);
        } catch (error: any) {
          console.warn(`Skipping embedding provider config ${file}: ${error.message}`);
        }
      }
    }
  });
}
