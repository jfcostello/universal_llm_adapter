import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadMCPServersInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  if (state.mcpServersLoaded) return;

  const { parseMCPManifest } = await import('../../../../../modules/mcp/index.js');

  if (state.mode === 'legacy') {
    const files = glob.sync('mcp/*.json', { cwd: state.rootPath }).sort();
    for (const file of files) {
      if (options.strict) {
        const manifestPath = path.join(state.rootPath, file);
        const manifest = loadJsonFile(manifestPath);
        const servers = parseMCPManifest(manifest, file);
        for (const server of servers) {
          state.mcpServers.set(server.id, server);
        }
        continue;
      }

      try {
        const manifestPath = path.join(state.rootPath, file);
        const manifest = loadJsonFile(manifestPath);
        const servers = parseMCPManifest(manifest, file);
        for (const server of servers) {
          state.mcpServers.set(server.id, server);
        }
      } catch (error: any) {
        console.warn(`Skipping MCP server manifest ${file}: ${error.message}`);
      }
    }

    state.mcpServersLoaded = true;
    return;
  }

  const roots = getPackRootsLowToHigh(state, 'mcp', 'manifests');
  for (const root of roots) {
    const files = glob.sync('mcp/*.json', { cwd: root.root }).sort();
    for (const file of files) {
      const manifestPath = path.join(root.root, file);
      const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: manifestPath, precedence: root.precedence };

      if (options.strict) {
        const manifest = loadJsonFile(manifestPath);
        const servers = parseMCPManifest(manifest, file);
        for (const server of servers) {
          const id = server.id;
          if (!id) {
            throw new ManifestError(`Invalid MCP server manifest '${manifestPath}': missing id`);
          }
          const prev = getManifestSource(state, 'mcp', id);
          if (prev) warnOnOverride(state, 'mcp', id, prev, source);
          state.mcpServers.set(id, server);
          setManifestSource(state, 'mcp', id, source);
        }
        continue;
      }

      try {
        const manifest = loadJsonFile(manifestPath);
        const servers = parseMCPManifest(manifest, file);
        for (const server of servers) {
          const id = server.id;
          if (!id) {
            console.warn(`Skipping MCP server manifest ${file}: missing id`);
            continue;
          }
          const prev = getManifestSource(state, 'mcp', id);
          if (prev) warnOnOverride(state, 'mcp', id, prev, source);
          state.mcpServers.set(id, server);
          setManifestSource(state, 'mcp', id, source);
        }
      } catch (error: any) {
        console.warn(`Skipping MCP server manifest ${file}: ${error.message}`);
      }
    }
  }

  state.mcpServersLoaded = true;
}
