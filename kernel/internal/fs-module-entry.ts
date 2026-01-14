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
export function resolveModuleEntryInRoot(root: string, moduleName: string): string | undefined {
  // Prefer module directories: <root>/<name>/index.(js|ts)
  const dir = path.join(root, moduleName);
  const dirIndexJs = path.join(dir, 'index.js');
  const dirIndexTs = path.join(dir, 'index.ts');

  if (fs.existsSync(dirIndexJs)) return dirIndexJs;
  if (fs.existsSync(dirIndexTs)) return dirIndexTs;

  // Fall back to legacy single-file modules: <root>/<name>.(js|ts)
  const fileJs = path.join(root, `${moduleName}.js`);
  const fileTs = path.join(root, `${moduleName}.ts`);

  if (fs.existsSync(fileJs)) return fileJs;
  if (fs.existsSync(fileTs)) return fileTs;

  return undefined;
}

