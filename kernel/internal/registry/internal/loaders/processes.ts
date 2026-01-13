import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { ProcessRouteManifest } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadProcessRoutesInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'processRoutesLoaded', 'processes', async () => {
    if (state.mode === 'legacy') {
      await forEachManifestFile(
        state,
        {
          area: 'processes',
          pattern: 'processes/*.json',
          strict: options.strict,
          skipLabel: 'process route manifest'
        },
        (file) => {
          const route = loadJsonFile(file.fullPath) as ProcessRouteManifest;
          const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';

          if (options.strict) {
            if (!id) {
              throw new ManifestError(`Invalid process route manifest '${file.fullPath}': missing id`);
            }
          } else if (!id) {
            console.warn(`Skipping process route manifest ${file.file}: missing id`);
            return;
          }

          state.processRoutes.push(route);
          upsertManifestWithSource(state, 'processes', id, file.source, () => {});
        }
      );

      return;
    }

    const routesById = new Map<string, ProcessRouteManifest>();

    await forEachManifestFile(
      state,
      {
        area: 'processes',
        pattern: 'processes/*.json',
        strict: options.strict,
        skipLabel: 'process route manifest'
      },
      (file) => {
        const route = loadJsonFile(file.fullPath) as ProcessRouteManifest;
        const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';

        if (options.strict) {
          if (!id) {
            throw new ManifestError(`Invalid process route manifest '${file.fullPath}': missing id`);
          }
        } else if (!id) {
          console.warn(`Skipping process route manifest ${file.file}: missing id`);
          return;
        }

        upsertManifestWithSource(state, 'processes', id, file.source, () => {
          routesById.set(id, route);
        });
      }
    );

    state.processRoutes = Array.from(routesById.values());
  });
}
