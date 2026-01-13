import * as path from 'path';
import { glob } from 'glob';

import type { ManifestSourceMeta } from './public-types.js';
import type { PluginRegistryState } from './state.js';
import { getManifestSource, getPackRootsLowToHigh, setManifestSource, warnOnOverride } from './lookup.js';

export interface ManifestFileInfo {
  file: string;
  fullPath: string;
  source: ManifestSourceMeta;
  isMultiRoot: boolean;
}

function listManifestFiles(
  state: PluginRegistryState,
  area: string,
  pattern: string
): ManifestFileInfo[] {
  if (state.mode === 'legacy') {
    const files = glob.sync(pattern, { cwd: state.rootPath }).sort();
    return files.map((file) => {
      const fullPath = path.join(state.rootPath, file);
      return {
        file,
        fullPath,
        source: { kind: 'local', root: state.rootPath, filePath: fullPath, precedence: 0 },
        isMultiRoot: false
      };
    });
  }

  const out: ManifestFileInfo[] = [];
  const roots = getPackRootsLowToHigh(state, area, 'manifests');
  for (const root of roots) {
    const files = glob.sync(pattern, { cwd: root.root }).sort();
    for (const file of files) {
      const fullPath = path.join(root.root, file);
      out.push({
        file,
        fullPath,
        source: { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence },
        isMultiRoot: true
      });
    }
  }
  return out;
}

export async function forEachManifestFile(
  state: PluginRegistryState,
  options: { area: string; pattern: string; strict?: boolean; skipLabel: string },
  fn: (file: ManifestFileInfo) => Promise<void> | void
): Promise<void> {
  const files = listManifestFiles(state, options.area, options.pattern);

  for (const file of files) {
    if (options.strict) {
      await fn(file);
      continue;
    }

    try {
      await fn(file);
    } catch (error: any) {
      const message = error?.message ? String(error.message) : String(error);
      console.warn(`Skipping ${options.skipLabel} ${file.file}: ${message}`);
    }
  }
}

export function upsertManifestWithSource(
  state: PluginRegistryState,
  area: string,
  id: string,
  source: ManifestSourceMeta,
  apply: () => void
): void {
  const prev = getManifestSource(state, area, id);
  if (prev) warnOnOverride(state, area, id, prev, source);
  apply();
  setManifestSource(state, area, id, source);
}

