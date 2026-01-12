import * as path from 'path';

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalize a list of external root paths:
 * - trims entries
 * - resolves relative entries against `cwd`
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
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

