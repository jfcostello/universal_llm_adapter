import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from './paths.js';

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

// Cache for resolved extension paths - keyed by "packageRoot:extensionId"
const pathsCache = new Map<string, ExtensionPaths>();

/**
 * Get the resolved paths for an extension.
 *
 * Resolution order (first match with existing plugins directory wins):
 * 1. packageRoot/extensions/{extensionId}/plugins (production/dist or custom root)
 * 2. cwd/extensions/{extensionId}/plugins (development/source fallback)
 *
 * If no plugins directory is found, returns packageRoot-based paths as fallback.
 *
 * Results are cached for performance since extension locations don't change at runtime.
 *
 * @param extensionId - The extension identifier (e.g., 'voice')
 * @param options - Optional configuration, primarily for testing
 * @returns The resolved extension paths
 */
export function getExtensionPaths(
  extensionId: string,
  options?: GetExtensionPathsOptions
): ExtensionPaths {
  const packageRoot = options?.packageRoot ?? PACKAGE_ROOT;
  const cacheKey = `${packageRoot}:${extensionId}`;

  const cached = pathsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(packageRoot, 'extensions', extensionId),
    path.resolve(cwd, 'extensions', extensionId)
  ];

  for (const extensionRoot of candidates) {
    const pluginsRoot = path.join(extensionRoot, 'plugins');
    if (fs.existsSync(pluginsRoot)) {
      const result: ExtensionPaths = { extensionRoot, pluginsRoot };
      pathsCache.set(cacheKey, result);
      return result;
    }
  }

  // Fallback: return packageRoot path (may not exist, but consistent)
  const fallbackRoot = path.resolve(packageRoot, 'extensions', extensionId);
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
}
