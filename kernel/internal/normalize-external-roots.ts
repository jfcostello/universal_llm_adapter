import * as fs from 'fs';
import * as path from 'path';

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function realpathIfExists(resolvedPath: string): { canonical: string; warning?: string } {
  try {
    if (fs.existsSync(resolvedPath)) {
      return { canonical: fs.realpathSync(resolvedPath) };
    }
    return { canonical: resolvedPath, warning: 'path does not exist' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { canonical: resolvedPath, warning: `failed to resolve realpath: ${message}` };
  }
}

/**
 * Normalize a list of external root paths:
 * - trims entries
 * - resolves relative entries against `cwd`
 * - canonicalizes to real paths when the root exists
 * - removes duplicates while preserving order
 */
export function normalizeExternalRoots(cwd: string, raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const s = normalizeString(item);
    if (!s) continue;
    const resolved = path.isAbsolute(s) ? s : path.resolve(cwd, s);
    const { canonical, warning } = realpathIfExists(resolved);
    if (warning) {
      console.warn('external_roots.path_resolution_warning', { path: resolved, warning });
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }

  return result;
}
