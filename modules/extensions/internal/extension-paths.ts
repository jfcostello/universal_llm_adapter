import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT, getAdapterPathsConfig } from '../../../kernel/index.js';

/**
 * Options for getExtensionPluginRoots. The packageRoot option is primarily for testing.
 */
export interface GetExtensionPluginRootsOptions {
  /** Override the package root for testing. Defaults to PACKAGE_ROOT. */
  packageRoot?: string;
}

// Cache for resolved plugin roots - keyed by "cwd:packageRoot:extensionId"
const pluginRootsCache = new Map<string, string[]>();
let cachedPluginRootsCwd: string | undefined;

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
 * Get all plugin roots for an extension, in priority order.
 *
 * Returns ALL existing plugin directories from multiple sources so callers can
 * search for their specific files (manifests, compats, etc.) across all locations.
 * This handles TypeScript projects where compiled JS may be in dist/ but JSON
 * manifests remain in source.
 *
 * Resolution order (priority, highest first):
 * 1. External roots from llm-adapter.paths.json config (if present)
 * 2. packageRoot/extensions/{extensionId}/plugins (production/dist or custom root)
 * 3. cwd/extensions/{extensionId}/plugins (development/source fallback)
 *
 * Only returns directories that actually exist. Returns empty array if no
 * plugin directories are found.
 *
 * Results are cached for performance. Cache invalidates when cwd changes.
 * Paths are canonicalized using realpathSync to handle symlinks (e.g., macOS /var -> /private/var).
 *
 * @param extensionId - The extension identifier (e.g., 'voice')
 * @param options - Optional configuration, primarily for testing
 * @returns Array of plugin root paths that exist, in priority order
 */
export function getExtensionPluginRoots(
  extensionId: string,
  options?: GetExtensionPluginRootsOptions
): string[] {
  const cwd = process.cwd();

  // Invalidate cache if cwd has changed (following defaults.ts pattern)
  if (cachedPluginRootsCwd !== undefined && cachedPluginRootsCwd !== cwd) {
    pluginRootsCache.clear();
  }
  cachedPluginRootsCwd = cwd;

  const packageRoot = options?.packageRoot ?? PACKAGE_ROOT;
  // Canonicalize packageRoot for consistent cache keys
  const canonicalPackageRoot = realpathIfExists(packageRoot);
  const canonicalCwd = realpathIfExists(cwd);
  const cacheKey = `${canonicalCwd}:${canonicalPackageRoot}:${extensionId}`;

  const cached = pluginRootsCache.get(cacheKey);
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
      candidates.push(path.resolve(extRoot, extensionId, 'plugins'));
    }
  }

  // Add packageRoot and cwd candidates
  candidates.push(path.resolve(canonicalPackageRoot, 'extensions', extensionId, 'plugins'));
  candidates.push(path.resolve(canonicalCwd, 'extensions', extensionId, 'plugins'));

  // Filter to existing directories and canonicalize paths
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const canonicalPath = realpathIfExists(candidate);
      // Deduplicate (e.g., when packageRoot === cwd)
      if (!seen.has(canonicalPath)) {
        seen.add(canonicalPath);
        result.push(canonicalPath);
      }
    }
  }

  pluginRootsCache.set(cacheKey, result);
  return result;
}

/**
 * Clear the extension plugin roots cache.
 * Primarily used for testing to ensure clean state between tests.
 */
export function resetExtensionPluginRootsCache(): void {
  pluginRootsCache.clear();
  cachedPluginRootsCwd = undefined;
}
