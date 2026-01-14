import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve a module entrypoint inside a directory without scanning.
 *
 * Resolution order:
 * 1) <root>/<name>/index.js
 * 2) <root>/<name>/index.ts
 * 3) <root>/<name>.js
 * 4) <root>/<name>.ts
 */
function resolveModuleEntryInRoot(root: string, moduleName: string): string | undefined {
  const dir = path.join(root, moduleName);
  const dirIndexJs = path.join(dir, 'index.js');
  const dirIndexTs = path.join(dir, 'index.ts');

  if (fs.existsSync(dirIndexJs)) return dirIndexJs;
  if (fs.existsSync(dirIndexTs)) return dirIndexTs;

  const fileJs = path.join(root, `${moduleName}.js`);
  const fileTs = path.join(root, `${moduleName}.ts`);

  if (fs.existsSync(fileJs)) return fileJs;
  if (fs.existsSync(fileTs)) return fileTs;

  return undefined;
}

/**
 * Resolve a module entrypoint across multiple root directories.
 *
 * Searches each root in order, optionally appending a subdirectory, and returns
 * the first matching module entry. Useful for multi-root plugin resolution where
 * modules may exist in different locations (e.g., external roots, dist, source).
 *
 * @param roots - Array of root directories to search, in priority order
 * @param subdir - Subdirectory to append to each root before searching (e.g., 'compat')
 * @param moduleName - The module name to resolve
 * @returns The resolved module path, or undefined if not found in any root
 */
export function resolveModuleEntryAcrossRoots(
  roots: string[],
  subdir: string,
  moduleName: string
): string | undefined {
  for (const root of roots) {
    const searchDir = path.resolve(root, subdir);
    if (!fs.existsSync(searchDir)) continue;
    const found = resolveModuleEntryInRoot(searchDir, moduleName);
    if (found) return found;
  }
  return undefined;
}
