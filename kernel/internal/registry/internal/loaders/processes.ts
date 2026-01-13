import * as path from 'path';
import { glob } from 'glob';

import { loadJsonFile } from '../../../config.js';
import { ManifestError } from '../../../errors.js';
import type { ProcessRouteManifest } from '../../../types.js';

import type { ManifestSourceMeta } from '../public-types.js';
import type { PluginRegistryState } from '../state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from '../lookup.js';

export async function loadProcessRoutesInternal(state: PluginRegistryState, options: { strict?: boolean } = {}): Promise<void> {
  if (state.processRoutesLoaded) return;

  if (state.mode === 'legacy') {
    const files = glob.sync('processes/*.json', { cwd: state.rootPath }).sort();
    for (const file of files) {
      const fullPath = path.join(state.rootPath, file);
      const source: ManifestSourceMeta = { kind: 'local', root: state.rootPath, filePath: fullPath, precedence: 0 };

      if (options.strict) {
        const route = loadJsonFile(fullPath) as ProcessRouteManifest;
        const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';
        if (!id) {
          throw new ManifestError(`Invalid process route manifest '${fullPath}': missing id`);
        }

        state.processRoutes.push(route);
        setManifestSource(state, 'processes', id, source);
        continue;
      }

      try {
        const route = loadJsonFile(fullPath) as ProcessRouteManifest;
        const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';
        if (!id) {
          console.warn(`Skipping process route manifest ${file}: missing id`);
          continue;
        }

        state.processRoutes.push(route);
        setManifestSource(state, 'processes', id, source);
      } catch (error: any) {
        console.warn(`Skipping process route manifest ${file}: ${error.message}`);
      }
    }

    state.processRoutesLoaded = true;
    return;
  }

  const routesById = new Map<string, ProcessRouteManifest>();
  const roots = getPackRootsLowToHigh(state, 'processes', 'manifests');
  for (const root of roots) {
    const files = glob.sync('processes/*.json', { cwd: root.root }).sort();
    for (const file of files) {
      const fullPath = path.join(root.root, file);
      const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

      if (options.strict) {
        const route = loadJsonFile(fullPath) as ProcessRouteManifest;
        const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';
        if (!id) {
          throw new ManifestError(`Invalid process route manifest '${fullPath}': missing id`);
        }

        const prev = getManifestSource(state, 'processes', id);
        if (prev) warnOnOverride(state, 'processes', id, prev, source);
        routesById.set(id, route);
        setManifestSource(state, 'processes', id, source);
        continue;
      }

      try {
        const route = loadJsonFile(fullPath) as ProcessRouteManifest;
        const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';
        if (!id) {
          console.warn(`Skipping process route manifest ${file}: missing id`);
          continue;
        }

        const prev = getManifestSource(state, 'processes', id);
        if (prev) warnOnOverride(state, 'processes', id, prev, source);
        routesById.set(id, route);
        setManifestSource(state, 'processes', id, source);
      } catch (error: any) {
        console.warn(`Skipping process route manifest ${file}: ${error.message}`);
      }
    }
  }

  state.processRoutes = Array.from(routesById.values());

  state.processRoutesLoaded = true;
}

