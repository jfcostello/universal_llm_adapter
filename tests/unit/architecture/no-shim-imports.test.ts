import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

const BANNED_TOP_LEVEL_DIRS = new Set([
  'utils',
  'core',
  'managers',
  'coordinator',
  'mcp'
]);

function listTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'tests' ||
        entry.name === 'coverage' ||
        entry.name === '.history' ||
        entry.name === '.git'
      ) {
        continue;
      }
      results.push(...listTsFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    results.push(fullPath);
  }

  return results;
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  const patterns = [
    // import ... from '...'
    /\bimport\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    // export ... from '...'
    /\bexport\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    // dynamic import('...')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function getTopLevelDirForSpecifier(filePath: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) {
    const abs = path.resolve(REPO_ROOT, specifier.slice(2));
    const rel = path.relative(REPO_ROOT, abs);
    const first = rel.split(path.sep).filter(Boolean)[0];
    return first ?? null;
  }

  if (specifier.startsWith('.')) {
    const abs = path.resolve(path.dirname(filePath), specifier);
    const rel = path.relative(REPO_ROOT, abs);
    const first = rel.split(path.sep).filter(Boolean)[0];
    return first ?? null;
  }

  return null;
}

describe('architecture: no shim imports in runtime code', () => {
  test('shim directories are removed', () => {
    const stillPresent = [...BANNED_TOP_LEVEL_DIRS].filter((dir) =>
      fs.existsSync(path.join(REPO_ROOT, dir))
    );
    expect(stillPresent).toEqual([]);
  });

  test('no runtime .ts file imports from shim directories', () => {
    const files = listTsFiles(REPO_ROOT);
    const violations: Array<{ file: string; specifier: string; topLevel: string }> = [];

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      const specifiers = extractImportSpecifiers(text);

      for (const specifier of specifiers) {
        const topLevel = getTopLevelDirForSpecifier(file, specifier);
        if (!topLevel) continue;
        if (!BANNED_TOP_LEVEL_DIRS.has(topLevel)) continue;
        violations.push({
          file: path.relative(REPO_ROOT, file),
          specifier,
          topLevel
        });
      }
    }

    if (violations.length > 0) {
      const formatted = violations
        .map(v => `- ${v.file}: "${v.specifier}" (top-level: ${v.topLevel})`)
        .join('\n');
      throw new Error(`Found shim imports in runtime code:\n${formatted}`);
    }
  });
});
