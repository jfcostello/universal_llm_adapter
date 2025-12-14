import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.history',
  'logs'
]);

function walk(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function toRepoRelative(filePath: string): string {
  return path.relative(ROOT_DIR, filePath).replaceAll(path.sep, '/');
}

function isUnder(dirName: string, filePath: string): boolean {
  const rel = toRepoRelative(filePath);
  return rel === dirName || rel.startsWith(`${dirName}/`);
}

function extractImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];

  // Static imports/exports:
  //   import x from '...'
  //   import type { X } from '...'
  //   import '...'
  //   export * from '...'
  //   export { x } from '...'
  const staticRe = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (;;) {
    const match = staticRe.exec(sourceText);
    if (!match) break;
    specifiers.push(match[1]);
  }

  // Dynamic imports:
  //   await import('...')
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (;;) {
    const match = dynamicRe.exec(sourceText);
    if (!match) break;
    specifiers.push(match[1]);
  }

  return specifiers;
}

describe('guardrails/repo', () => {
  test("production code does not import another module's internal/** paths", () => {
    const files = walk(ROOT_DIR)
      .filter(f => f.endsWith('.ts'))
      .filter(f => !isUnder('tests', f));

    const offenders: Array<{ file: string; specifier: string }> = [];

    for (const file of files) {
      const moduleRoot = findNearestModuleRoot(file);
      const text = fs.readFileSync(file, 'utf8');
      const specifiers = extractImportSpecifiers(text);
      for (const spec of specifiers) {
        if (spec.includes('/internal/')) {
          if (!spec.startsWith('.')) {
            offenders.push({ file: toRepoRelative(file), specifier: spec });
            continue;
          }

          const resolved = path.resolve(path.dirname(file), spec);
          if (!resolved.startsWith(`${moduleRoot}${path.sep}`) && resolved !== moduleRoot) {
            offenders.push({ file: toRepoRelative(file), specifier: spec });
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('provider/model/endpoint/API/SDK names do not appear outside plugins', () => {
    const disallowedTokens = [
      'anthropic',
      'openai',
      'openrouter',
      'google',
      'gemini',
      'qdrant',
      'claude',
      'gpt'
    ];

    const files = walk(ROOT_DIR)
      .filter(f => f.endsWith('.ts'))
      .filter(f => !isUnder('tests', f))
      .filter(f => !isUnder('plugins', f));

    const offenders: Array<{ file: string; token: string }> = [];

    for (const file of files) {
      const rel = toRepoRelative(file);
      const lower = fs.readFileSync(file, 'utf8').toLowerCase();
      for (const token of disallowedTokens) {
        if (lower.includes(token)) {
          offenders.push({ file: rel, token });
        }
      }
    }

    // Also scan tracked docs (exclude tests/** and plugins/** to avoid legitimate provider/plugin docs).
    const trackedDocs = execSync('git ls-files', { cwd: ROOT_DIR, encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(p => p.endsWith('.md'))
      .map(p => path.join(ROOT_DIR, p))
      .filter(f => !isUnder('tests', f))
      .filter(f => !isUnder('plugins', f));

    for (const file of trackedDocs) {
      const rel = toRepoRelative(file);
      const lower = fs.readFileSync(file, 'utf8').toLowerCase();
      for (const token of disallowedTokens) {
        if (lower.includes(token)) {
          offenders.push({ file: rel, token });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function findNearestModuleRoot(filePath: string): string {
  let currentDir = path.dirname(filePath);

  while (true) {
    if (fs.existsSync(path.join(currentDir, 'index.ts'))) {
      return currentDir;
    }

    if (currentDir === ROOT_DIR) {
      return path.dirname(filePath);
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return path.dirname(filePath);
    }
    currentDir = parent;
  }
}
