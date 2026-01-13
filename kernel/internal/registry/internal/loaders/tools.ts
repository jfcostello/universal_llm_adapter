import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { UnifiedTool } from '../../../types.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadToolsInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'toolsLoaded', 'tools', async () => {
    await forEachManifestFile(
      state,
      { area: 'tools', pattern: 'tools/*.json', strict: options.strict, skipLabel: 'tool manifest' },
      (file) => {
        const tool = loadJsonFile(file.fullPath) as UnifiedTool;

        if (!file.isMultiRoot) {
          state.tools.set(tool.name, tool);
          return;
        }

        const name = typeof (tool as any)?.name === 'string' ? String((tool as any).name) : '';

        if (options.strict) {
          if (!name) {
            throw new ManifestError(`Invalid tool manifest '${file.fullPath}': missing name`);
          }

          upsertManifestWithSource(state, 'tools', name, file.source, () => {
            state.tools.set(name, tool);
          });
          return;
        }

        if (!name) {
          console.warn(`Skipping tool manifest ${file.file}: missing name`);
          return;
        }

        upsertManifestWithSource(state, 'tools', name, file.source, () => {
          state.tools.set(name, tool);
        });
      }
    );
  });
}
