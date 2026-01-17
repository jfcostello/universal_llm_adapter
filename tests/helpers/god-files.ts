import fs from 'fs';
import path from 'path';

export type GodFileViolation = { filePath: string; lineCount: number };

export type GodFileScanOptions = {
  rootDir: string;
  maxLines: number;
};

const DEFAULT_IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'logs',
  '.history',
  '.worktrees',
  '.cache',
  '.turbo',
  '.next',
  'out',
  'tmp',
  'temp'
]);

const EXEMPT_FILE_EXTENSIONS = new Set(['.md', '.txt', '.json']);

const CODE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]);

function isTestPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('tests/')) return true;
  if (normalized.startsWith('__tests__/')) return true;
  if (normalized.includes('/tests/')) return true;
  if (normalized.includes('/__tests__/')) return true;

  const base = path.posix.basename(normalized);
  if (base.includes('.test.')) return true;
  if (base.includes('.spec.')) return true;
  return false;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  if (text.charCodeAt(text.length - 1) === 10) lines -= 1;
  return lines;
}

function isIgnoredDir(dirName: string): boolean {
  return DEFAULT_IGNORED_DIR_NAMES.has(dirName);
}

function isExemptFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (EXEMPT_FILE_EXTENSIONS.has(ext)) return true;
  return false;
}

function isCodeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_FILE_EXTENSIONS.has(ext);
}

export function findGodFileViolations(options: GodFileScanOptions): GodFileViolation[] {
  const rootDir = path.resolve(options.rootDir);
  const maxLines = Math.max(1, Math.floor(options.maxLines));

  const violations: GodFileViolation[] = [];

  const visit = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      const filePath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, filePath);

      if (isTestPath(relPath)) continue;
      if (isExemptFile(filePath)) continue;
      if (!isCodeFile(filePath)) continue;

      const text = fs.readFileSync(filePath, 'utf8');
      const lineCount = countLines(text);
      if (lineCount > maxLines) {
        violations.push({ filePath: relPath.replace(/\\/g, '/'), lineCount });
      }
    }
  };

  visit(rootDir);

  return violations.sort((a, b) => b.lineCount - a.lineCount || a.filePath.localeCompare(b.filePath));
}

export function formatGodFileViolations(violations: GodFileViolation[]): string {
  if (violations.length === 0) return '';
  return violations.map(v => `${String(v.lineCount).padStart(6, ' ')}  ${v.filePath}`).join('\n');
}
