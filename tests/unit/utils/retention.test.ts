import fs from 'fs';
import { jest } from '@jest/globals';
import path from 'path';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('utils/logging/retention', () => {
  test('enforceRetention handles missing directory gracefully', async () => {
    const mod = await import('@/utils/logging/retention.ts');
    const deleted = mod.enforceRetention(path.join(process.cwd(), 'nope'), { maxFiles: 2 });
    expect(deleted).toEqual([]);
  });

  test('enforceRetention keeps newest N files and deletes older', async () => {
    await withTempCwd('retention-basic', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const files = ['a.log', 'b.log', 'c.log'];
      files.forEach((f, i) => {
        const p = path.join(dir, f);
        fs.writeFileSync(p, f);
        // older mtime for earlier letters
        const when = new Date(Date.now() - (files.length - i) * 1000);
        fs.utimesSync(p, when, when);
      });

      const deleted = mod.enforceRetention(dir, {
        maxFiles: 2,
        includeDirs: false,
        match: (d) => d.isFile() && d.name.endsWith('.log')
      });

      // One file should be deleted (the oldest 'a.log')
      expect(deleted.length).toBe(1);
      expect(fs.existsSync(path.join(dir, 'a.log'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'b.log'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'c.log'))).toBe(true);
    });
  });

  test('readEnvInt and readEnvFloat parse valid values and fallback on invalid', async () => {
    const mod = await import('@/utils/logging/retention.ts');
    const prev = { ...process.env };
    try {
      process.env.MY_INT = '42';
      process.env.MY_FLOAT = '2.5';
      expect(mod.readEnvInt('MY_INT', 5)).toBe(42);
      expect(mod.readEnvFloat('MY_FLOAT', 1)).toBe(2.5);

      process.env.MY_INT = 'NaN';
      process.env.MY_FLOAT = '-1';
      expect(mod.readEnvInt('MY_INT', 7)).toBe(7);
      expect(mod.readEnvFloat('MY_FLOAT', 3)).toBe(3);
    } finally {
      process.env = prev;
    }
  });

  test('enforceRetention tolerates rmSync failures (catch path)', async () => {
    await withTempCwd('retention-rm-fail', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const f1 = path.join(dir, 'old.log');
      const f2 = path.join(dir, 'new.log');
      fs.writeFileSync(f1, 'old');
      fs.writeFileSync(f2, 'new');
      // Make f1 older
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(f1, old, old);

      const rmSpy = jest.spyOn(fs as any, 'rmSync').mockImplementation(() => {
        throw new Error('rm failed');
      });

      const deleted = mod.enforceRetention(dir, {
        maxFiles: 1,
        includeDirs: false,
        match: (d) => d.isFile()
      });

      expect(Array.isArray(deleted)).toBe(true);
      rmSpy.mockRestore();

      // After failure, both files may still exist; key is that function did not throw
      expect(fs.existsSync(f1) || fs.existsSync(f2)).toBe(true);
    });
  });

  test('time-based retention deletes entries older than maxAgeDays', async () => {
    await withTempCwd('retention-time-based', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const oldFile = path.join(dir, 'old.log');
      const newFile = path.join(dir, 'new.log');
      fs.writeFileSync(oldFile, 'old');
      fs.writeFileSync(newFile, 'new');

      // Make oldFile 2 days old
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

      const deleted = mod.enforceRetention(dir, {
        maxFiles: 10,
        includeDirs: false,
        match: (d) => d.isFile(),
        maxAgeDays: 1
      });

      expect(deleted).toContain(oldFile);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
    });
  });

  test('default matcher (files only) works when includeDirs omitted', async () => {
    await withTempCwd('retention-default-match', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.log'), 'a');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
      const deleted = mod.enforceRetention(dir, { maxFiles: 1 });
      expect(deleted.length).toBe(1);
    });
  });

  test('time-based retention respects exclude list', async () => {
    await withTempCwd('retention-time-exclude', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const keep = path.join(dir, 'keep.log');
      const drop = path.join(dir, 'drop.log');
      fs.writeFileSync(keep, 'k');
      fs.writeFileSync(drop, 'd');
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      fs.utimesSync(keep, old, old);
      fs.utimesSync(drop, old, old);

      const deleted = mod.enforceRetention(dir, {
        maxFiles: 10,
        maxAgeDays: 1,
        exclude: [keep]
      });

      expect(deleted).toContain(drop);
      expect(fs.existsSync(keep)).toBe(true);
    });
  });

  test('sort fallback by name kicks in when mtimes are equal', async () => {
    await withTempCwd('retention-sort-fallback', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const a = path.join(dir, 'a.log');
      const b = path.join(dir, 'b.log');
      fs.writeFileSync(a, 'a');
      fs.writeFileSync(b, 'b');
      const same = new Date(Date.now());
      fs.utimesSync(a, same, same);
      fs.utimesSync(b, same, same);
      const deleted = mod.enforceRetention(dir, { maxFiles: 1 });
      expect(deleted.length).toBe(1);
    });
  });

  test('includeDirs=true prunes oldest directories and honors exclude', async () => {
    await withTempCwd('retention-dirs', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const root = path.join(cwd, 'logs');
      fs.mkdirSync(root, { recursive: true });

      const dirs = ['batch-a', 'batch-b', 'batch-c'];
      for (let i = 0; i < dirs.length; i++) {
        const d = path.join(root, dirs[i]);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'llm.log'), 'x');
        const when = new Date(Date.now() - (dirs.length - i) * 1000);
        fs.utimesSync(d, when, when);
      }
      // Also place a file at root to exercise includeDirs=true path that sees files
      fs.writeFileSync(path.join(root, 'misc.log'), 'misc');

      const keep = path.join(root, 'batch-b');
      const deleted = mod.enforceRetention(root, {
        maxFiles: 2,
        includeDirs: true,
        exclude: [keep]
      });

      // Oldest directory 'batch-a' should be deleted, 'batch-b' excluded, 'batch-c' newest kept
      expect(deleted).toContain(path.join(root, 'batch-a'));
      expect(fs.existsSync(path.join(root, 'batch-a'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'batch-b'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'batch-c'))).toBe(true);
    });
  });
});
