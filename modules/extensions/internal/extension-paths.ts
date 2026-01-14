import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT, getAdapterPathsConfig } from '../../../kernel/index.js';

/**
 * Resolved paths for an extension.
 */
export interface ExtensionPaths {
  /** The root directory of the extension (e.g., /path/to/extensions/voice) */
  extensionRoot: string;
  /** The plugins directory within the extension (e.g., /path/to/extensions/voice/plugins) */
  pluginsRoot: string;
}

/**
 * Options for getExtensionPaths. The packageRoot option is primarily for testing.
 */
export interface GetExtensionPathsOptions {
  /** Override the package root for testing. Defaults to PACKAGE_ROOT. */
  packageRoot?: string;
}

// Cache for resolved extension paths - keyed by "cwd:packageRoot:extensionId"
const pathsCache = new Map<string, ExtensionPaths>();
let cachedExtensionPathsCwd: string | undefined;

/**
 * Resolve a path to its canonical form using realpathSync if it exists.
 * Returns the original path if the path doesn't exist or realpath fails.
 */
function realpathIfExists(resolvedPath: string): string {
  try {
    if (fs.existsSync(resolvedPath)) {
      return fs.realpathSync(resolvedPath);
    }
  } catch {
    // Fall through to return original path
  }
  return resolvedPath;
}

/**
 * Get the resolved paths for an extension.
 *
 * Resolution order (first match with existing plugins directory wins):
 * 1. External roots from llm-adapter.paths.json config (if present)
 * 2. packageRoot/extensions/{extensionId}/plugins (production/dist or custom root)
 * 3. cwd/extensions/{extensionId}/plugins (development/source fallback)
 *
 * If no plugins directory is found, returns packageRoot-based paths as fallback.
 *
 * Results are cached for performance. Cache invalidates when cwd changes.
 * Paths are canonicalized using realpathSync to handle symlinks (e.g., macOS /var -> /private/var).
 *
 * @param extensionId - The extension identifier (e.g., 'voice')
 * @param options - Optional configuration, primarily for testing
 * @returns The resolved extension paths
 */
export function getExtensionPaths(
  extensionId: string,
  options?: GetExtensionPathsOptions
): ExtensionPaths {
  const cwd = process.cwd();

  // Invalidate cache if cwd has changed (following defaults.ts pattern)
  if (cachedExtensionPathsCwd !== undefined && cachedExtensionPathsCwd !== cwd) {
    pathsCache.clear();
  }
  cachedExtensionPathsCwd = cwd;

  const packageRoot = options?.packageRoot ?? PACKAGE_ROOT;
  // Canonicalize packageRoot for consistent cache keys
  const canonicalPackageRoot = realpathIfExists(packageRoot);
  const canonicalCwd = realpathIfExists(cwd);
  const cacheKey = `${canonicalCwd}:${canonicalPackageRoot}:${extensionId}`;

  const cached = pathsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Build candidates list: external roots first, then packageRoot, then cwd
  const candidates: string[] = [];

  // Check for external roots from adapter paths config
  const pathsConfig = getAdapterPathsConfig();
  if (pathsConfig) {
    const externalRoots = pathsConfig.paths.lookup.extensions.externalRoots;
    for (const extRoot of externalRoots) {
      candidates.push(path.resolve(extRoot, extensionId));
    }
  }

  // Add packageRoot and cwd candidates
  candidates.push(path.resolve(canonicalPackageRoot, 'extensions', extensionId));
  candidates.push(path.resolve(canonicalCwd, 'extensions', extensionId));

  for (const extensionRoot of candidates) {
    const pluginsRoot = path.join(extensionRoot, 'plugins');
    if (fs.existsSync(pluginsRoot)) {
      // Canonicalize found paths
      const canonicalExtRoot = realpathIfExists(extensionRoot);
      const canonicalPluginsRoot = realpathIfExists(pluginsRoot);
      const result: ExtensionPaths = {
        extensionRoot: canonicalExtRoot,
        pluginsRoot: canonicalPluginsRoot
      };
      pathsCache.set(cacheKey, result);
      return result;
    }
  }

  // Fallback: return packageRoot path (may not exist, but consistent)
  const fallbackRoot = path.resolve(canonicalPackageRoot, 'extensions', extensionId);
  const result: ExtensionPaths = {
    extensionRoot: fallbackRoot,
    pluginsRoot: path.join(fallbackRoot, 'plugins')
  };
  pathsCache.set(cacheKey, result);
  return result;
}

/**
 * Clear the extension paths cache.
 * Primarily used for testing to ensure clean state between tests.
 */
export function resetExtensionPathsCache(): void {
  pathsCache.clear();
  cachedExtensionPathsCwd = undefined;
}
