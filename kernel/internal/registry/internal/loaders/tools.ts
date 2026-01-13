import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { UnifiedTool } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadToolsInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  if (state.toolsLoaded) return;

  if (state.mode === 'legacy') {
    const files = glob.sync('tools/*.json', { cwd: state.rootPath }).sort();
    for (const file of files) {
      if (options.strict) {
        const tool = loadJsonFile(path.join(state.rootPath, file)) as UnifiedTool;
        state.tools.set(tool.name, tool);
        continue;
      }

      try {
        const tool = loadJsonFile(path.join(state.rootPath, file)) as UnifiedTool;
        state.tools.set(tool.name, tool);
      } catch (error: any) {
        console.warn(`Skipping tool manifest ${file}: ${error.message}`);
      }
    }

    state.toolsLoaded = true;
    return;
  }

  const roots = getPackRootsLowToHigh(state, 'tools', 'manifests');
  for (const root of roots) {
    const files = glob.sync('tools/*.json', { cwd: root.root }).sort();
    for (const file of files) {
      const fullPath = path.join(root.root, file);
      const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

      if (options.strict) {
        const tool = loadJsonFile(fullPath) as UnifiedTool;
        const name = typeof (tool as any)?.name === 'string' ? String((tool as any).name) : '';
        if (!name) {
          throw new ManifestError(`Invalid tool manifest '${fullPath}': missing name`);
        }

        const prev = getManifestSource(state, 'tools', name);
        if (prev) warnOnOverride(state, 'tools', name, prev, source);
        state.tools.set(name, tool);
        setManifestSource(state, 'tools', name, source);
        continue;
      }

      try {
        const tool = loadJsonFile(fullPath) as UnifiedTool;
        const name = typeof (tool as any)?.name === 'string' ? String((tool as any).name) : '';
        if (!name) {
          console.warn(`Skipping tool manifest ${file}: missing name`);
          continue;
        }

        const prev = getManifestSource(state, 'tools', name);
        if (prev) warnOnOverride(state, 'tools', name, prev, source);
        state.tools.set(name, tool);
        setManifestSource(state, 'tools', name, source);
      } catch (error: any) {
        console.warn(`Skipping tool manifest ${file}: ${error.message}`);
      }
    }
  }

  state.toolsLoaded = true;
}

