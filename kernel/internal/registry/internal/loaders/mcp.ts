import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';

import type { PluginRegistryState } from '../state.js';
import { runLoaderOnce } from '../loader-lock.js';
import { forEachManifestFile, upsertManifestWithSource } from '../manifest-loader.js';

export async function loadMCPServersInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  return runLoaderOnce(state, 'mcpServersLoaded', 'mcp', async () => {
    const { parseMCPManifest } = await import('../../../../../modules/mcp/index.js');

    await forEachManifestFile(
      state,
      { area: 'mcp', pattern: 'mcp/*.json', strict: options.strict, skipLabel: 'MCP server manifest' },
      (file) => {
        const manifest = loadJsonFile(file.fullPath);
        const servers = parseMCPManifest(manifest, file.file);

        for (const server of servers) {
          const id = server.id;

          if (!file.isMultiRoot) {
            state.mcpServers.set(id, server);
            continue;
          }

          if (options.strict) {
            if (!id) {
              throw new ManifestError(`Invalid MCP server manifest '${file.fullPath}': missing id`);
            }

            upsertManifestWithSource(state, 'mcp', id, file.source, () => {
              state.mcpServers.set(id, server);
            });
            continue;
          }

          if (!id) {
            console.warn(`Skipping MCP server manifest ${file.file}: missing id`);
            continue;
          }

          upsertManifestWithSource(state, 'mcp', id, file.source, () => {
            state.mcpServers.set(id, server);
          });
        }
      }
    );
  });
}
