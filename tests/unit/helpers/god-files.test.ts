import { describe, expect, jest, test } from '@jest/globals';

import fs from 'fs';
import os from 'os';
import path from 'path';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFileLines(filePath: string, lines: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, Array.from({ length: lines }, () => 'x').join('\n'));
}

describe('tests/helpers/god-files', () => {
  test('findGodFileViolations uses git ls-files when available', async () => {
    const rootDir = makeTempDir('llm-adapter-god-files-git-');
    try {
      writeFileLines(path.join(rootDir, 'src', 'ok.ts'), 2);
      writeFileLines(path.join(rootDir, 'src', 'too-big.ts'), 3);
      writeFileLines(path.join(rootDir, 'tests', 'ignored.test.ts'), 999);
      fs.writeFileSync(path.join(rootDir, 'README.md'), 'hello');

      jest.resetModules();

      const spawnSync = jest.fn(() => ({
        status: 0,
        stdout: Buffer.from(['src/ok.ts', 'src/too-big.ts', 'tests/ignored.test.ts', 'README.md', ''].join('\u0000'), 'utf8')
      }));

      (jest as any).unstable_mockModule('child_process', () => ({ spawnSync }));

      const mod = await import('@tests/helpers/god-files.ts');
      const violations = mod.findGodFileViolations({ rootDir, maxLines: 2 });

      expect(spawnSync).toHaveBeenCalledWith('git', ['ls-files', '-z'], expect.objectContaining({ cwd: rootDir }));
      expect(violations).toEqual([{ filePath: 'src/too-big.ts', lineCount: 3 }]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('findGodFileViolations falls back to filesystem traversal when git ls-files fails', async () => {
    const rootDir = makeTempDir('llm-adapter-god-files-fallback-');
    try {
      writeFileLines(path.join(rootDir, 'src', 'too-big.ts'), 3);
      writeFileLines(path.join(rootDir, 'node_modules', 'ignored.ts'), 999);

      jest.resetModules();
      (jest as any).unstable_mockModule('child_process', () => ({
        spawnSync: () => ({ status: 1, stdout: Buffer.from('', 'utf8') })
      }));

      const mod = await import('@tests/helpers/god-files.ts');
      const violations = mod.findGodFileViolations({ rootDir, maxLines: 2 });

      expect(violations).toEqual([{ filePath: 'src/too-big.ts', lineCount: 3 }]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

