import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

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

const FALLBACK_IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.history',
  '.worktrees',
  '.cache',
  '.turbo',
  '.next',
  'out',
  'tmp',
  'temp'
]);

function listTrackedFiles(rootDir: string): string[] | null {
  try {
    const result = spawnSync('git', ['ls-files', '-z'], {
      cwd: rootDir,
      encoding: 'buffer',
      windowsHide: true
    });

    if (result.error) return null;
    if (result.status !== 0) return null;

    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8');
    if (stdout.length === 0) return [];
    return stdout
      .toString('utf8')
      .split('\u0000')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function findCodePathsUnderLogsFallback(rootDir: string): string[] {
  const root = path.resolve(rootDir);
  const violations: string[] = [];

  const visit = (dir: string, insideLogsDir: boolean) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (FALLBACK_IGNORED_DIR_NAMES.has(entry.name)) continue;
        const nextInsideLogsDir = insideLogsDir || entry.name === 'logs';
        visit(fullPath, nextInsideLogsDir);
        continue;
      }

      if (!insideLogsDir) continue;
      if (!entry.isFile()) continue;

      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (!isCodeFile(relPath)) continue;
      violations.push(relPath);
    }
  };

  visit(root, false);
  return violations;
}

function hasLogsDirectorySegment(relPath: string): boolean {
  return relPath.replace(/\\/g, '/').split('/').includes('logs');
}

function isCodeFile(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return CODE_FILE_EXTENSIONS.has(ext);
}

describe('architecture: no code under logs/ directories', () => {
  test('tracked code paths do not include a logs directory segment', () => {
    const tracked = listTrackedFiles(REPO_ROOT);
    const violations = tracked
      ? tracked
          .map((p) => String(p).replace(/\\/g, '/'))
          .filter((p) => isCodeFile(p))
          .filter((p) => hasLogsDirectorySegment(p))
          .sort((a, b) => a.localeCompare(b))
      : findCodePathsUnderLogsFallback(REPO_ROOT).sort((a, b) => a.localeCompare(b));

    if (violations.length > 0) {
      const formatted = violations.map((p) => `- ${p}`).join('\n');
      throw new Error(
        `Found code under logs/ directories.\n\n` +
          `These paths are likely to be excluded by npm packaging due to the repo's gitignore rule for logs/.\n\n` +
          `${formatted}`
      );
    }
  });
});
