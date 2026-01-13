import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { VectorStoreConfig } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadVectorStoresInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'vectorStoresLoaded', 'vector', async () => {
    if (state.mode === 'legacy') {
      const files = glob.sync('vector/*.json', { cwd: state.rootPath }).sort();
      for (const file of files) {
        if (options.strict) {
          const store = loadJsonFile(path.join(state.rootPath, file)) as VectorStoreConfig;
          state.vectorStores.set(store.id, store);
          continue;
        }

        try {
          const store = loadJsonFile(path.join(state.rootPath, file)) as VectorStoreConfig;
          state.vectorStores.set(store.id, store);
        } catch (error: any) {
          console.warn(`Skipping vector store manifest ${file}: ${error.message}`);
        }
      }

      return;
    }

    const roots = getPackRootsLowToHigh(state, 'vector', 'manifests');
    for (const root of roots) {
      const files = glob.sync('vector/*.json', { cwd: root.root }).sort();
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const store = loadJsonFile(fullPath) as VectorStoreConfig;
          const id = typeof (store as any)?.id === 'string' ? String((store as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid vector store manifest '${fullPath}': missing id`);
          }

          const prev = getManifestSource(state, 'vector', id);
          if (prev) warnOnOverride(state, 'vector', id, prev, source);
          state.vectorStores.set(id, store);
          setManifestSource(state, 'vector', id, source);
          continue;
        }

        try {
          const store = loadJsonFile(fullPath) as VectorStoreConfig;
          const id = typeof (store as any)?.id === 'string' ? String((store as any).id) : '';
          if (!id) {
            console.warn(`Skipping vector store manifest ${file}: missing id`);
            continue;
          }

          const prev = getManifestSource(state, 'vector', id);
          if (prev) warnOnOverride(state, 'vector', id, prev, source);
          state.vectorStores.set(id, store);
          setManifestSource(state, 'vector', id, source);
        } catch (error: any) {
          console.warn(`Skipping vector store manifest ${file}: ${error.message}`);
        }
      }
    }
  });
}
