import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const internalDir = path.dirname(fileURLToPath(import.meta.url));

// `kernel/internal` -> repo root (or dist root) (2 levels up)
const resolvedRoot = path.resolve(internalDir, '..', '..');

// Capture cwd at module load time (before any tests change it)
const initialCwd = process.cwd();

// Fallback: walk up to find package.json if plugins dir doesn't exist at resolved root
// This handles edge cases where import.meta.url doesn't resolve as expected (e.g., ts-jest on CI)
export function findPackageRoot(startDir: string): string {
  // If plugins directory exists at the resolved root, use it
  if (fs.existsSync(path.join(startDir, 'plugins'))) {
    return startDir;
  }

  // Walk up looking for package.json with our package name
  let current = startDir;
  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'llm-adapter' && fs.existsSync(path.join(current, 'plugins'))) {
          return current;
        }
      } catch {
        // Ignore parse errors, keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fallback to original resolution
  return startDir;
}

// Try import.meta.url resolution first, then fall back to cwd
// This handles ts-jest on CI where import.meta.url may not resolve correctly
const fromImportMeta = findPackageRoot(resolvedRoot);
const fromCwd = findPackageRoot(initialCwd);

export const PACKAGE_ROOT = fs.existsSync(path.join(fromImportMeta, 'plugins'))
  ? fromImportMeta
  : fromCwd;
