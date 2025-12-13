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

  test('enforceRetention tolerates ENOENT statSync races', async () => {
    await withTempCwd('retention-enoent-stat', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const a = path.join(dir, 'a.log');
      const b = path.join(dir, 'b.log');
      fs.writeFileSync(a, 'a');
      fs.writeFileSync(b, 'b');

      const realStatSync = fs.statSync.bind(fs);
      const statSpy = jest.spyOn(fs as any, 'statSync').mockImplementation((target: any) => {
        const full = String(target);
        if (full.endsWith(`${path.sep}a.log`)) {
          const err: any = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
        return realStatSync(target);
      });

      try {
        expect(() =>
          mod.enforceRetention(dir, {
            maxFiles: 1,
            includeDirs: false,
            match: (d) => d.isFile() && d.name.endsWith('.log')
          })
        ).not.toThrow();
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  test('enforceRetention rethrows non-ENOENT statSync errors (initial scan)', async () => {
    await withTempCwd('retention-stat-rethrow-initial', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(path.join(dir, 'a.log'), 'a');

      const statSpy = jest.spyOn(fs as any, 'statSync').mockImplementation(() => {
        const err: any = new Error('no access');
        err.code = 'EACCES';
        throw err;
      });

      try {
        expect(() => mod.enforceRetention(dir, { maxFiles: 1 })).toThrow();
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  test('enforceRetention rethrows non-ENOENT statSync errors (refresh scan)', async () => {
    await withTempCwd('retention-stat-rethrow-refresh', async (cwd) => {
      const mod = await import('@/utils/logging/retention.ts');
      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const a = path.join(dir, 'a.log');
      fs.writeFileSync(a, 'a');

      const realStatSync = fs.statSync.bind(fs);
      let calls = 0;
      const statSpy = jest.spyOn(fs as any, 'statSync').mockImplementation((target: any) => {
        calls += 1;
        if (calls >= 2) {
          const err: any = new Error('no access');
          err.code = 'EACCES';
          throw err;
        }
        return realStatSync(target);
      });

      try {
        expect(() => mod.enforceRetention(dir, { maxFiles: 1 })).toThrow();
      } finally {
        statSpy.mockRestore();
      }
    });
  });
});

describe('utils/logging/retention-manager', () => {
  test('applyRetentionOnce dedupes repeated calls when directory is unchanged', async () => {
    await withTempCwd('retention-manager-dedupe', async (cwd) => {
      const manager = await import('@/utils/logging/retention-manager.ts');
      manager.resetRetentionState();

      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const filePath = path.join(dir, 'a.log');
      fs.writeFileSync(filePath, 'a');

      const baseMtimeMs = 1_000_000_000;
      const base = new Date(baseMtimeMs);
      fs.utimesSync(filePath, base, base);

      const oneDayMs = 24 * 60 * 60 * 1000;
      let now = baseMtimeMs + oneDayMs - 1; // just under maxAgeDays threshold
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

      try {
        // First call: file is not old enough to delete
        manager.applyRetentionOnce(
          dir,
          {
            maxFiles: 10,
            maxAgeDays: 1,
            includeDirs: false,
            match: (d) => d.isFile() && d.name.endsWith('.log')
          },
          { minIntervalMs: 1_000_000, nowMs: 0 }
        );
        expect(fs.existsSync(filePath)).toBe(true);

        // Second call: file would now be old enough, but dedupe skips because the dir is unchanged.
        now = baseMtimeMs + oneDayMs + 1;
        manager.applyRetentionOnce(
          dir,
          {
            maxFiles: 10,
            maxAgeDays: 1,
            includeDirs: false,
            match: (d) => d.isFile() && d.name.endsWith('.log')
          },
          { minIntervalMs: 1_000_000, nowMs: 1 }
        );
        expect(fs.existsSync(filePath)).toBe(true);

        // Third call: outside the interval, retention runs and deletes the old file.
        manager.applyRetentionOnce(
          dir,
          {
            maxFiles: 10,
            maxAgeDays: 1,
            includeDirs: false,
            match: (d) => d.isFile() && d.name.endsWith('.log')
          },
          { minIntervalMs: 1_000_000, nowMs: 2_000_000 }
        );
        expect(fs.existsSync(filePath)).toBe(false);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  test('applyRetentionOnce uses default matcher when match is omitted', async () => {
    await withTempCwd('retention-manager-default-match', async (cwd) => {
      const manager = await import('@/utils/logging/retention-manager.ts');
      manager.resetRetentionState();

      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const a = path.join(dir, 'a.log');
      const b = path.join(dir, 'b.log');
      fs.writeFileSync(a, 'a');
      fs.writeFileSync(b, 'b');

      // Also create a directory; default match should ignore it (files only).
      fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });

      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(a, old, old);

      manager.applyRetentionOnce(dir, { maxFiles: 1 }, { nowMs: 0, minIntervalMs: 0 });
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(true);
    });
  });

  test('applyRetentionOnce default match supports includeDirs=true', async () => {
    await withTempCwd('retention-manager-default-match-dirs', async (cwd) => {
      const manager = await import('@/utils/logging/retention-manager.ts');
      manager.resetRetentionState();

      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const d1 = path.join(dir, 'batch-a');
      const d2 = path.join(dir, 'batch-b');
      fs.mkdirSync(d1, { recursive: true });
      fs.mkdirSync(d2, { recursive: true });
      fs.writeFileSync(path.join(dir, 'misc.log'), 'x');

      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(d1, old, old);

      manager.applyRetentionOnce(dir, { maxFiles: 1, includeDirs: true }, { nowMs: 0, minIntervalMs: 0 });
      expect(fs.existsSync(d1)).toBe(false);
      expect(fs.existsSync(d2)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'misc.log'))).toBe(true);
    });
  });

  test('applyRetentionOnce handles match toString throwing (policy key)', async () => {
    await withTempCwd('retention-manager-match-key-throws', async (cwd) => {
      const manager = await import('@/utils/logging/retention-manager.ts');
      manager.resetRetentionState();

      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const a = path.join(dir, 'a.log');
      const b = path.join(dir, 'b.log');
      fs.writeFileSync(a, 'a');
      fs.writeFileSync(b, 'b');

      const match: any = (d: any) => d.isFile() && d.name.endsWith('.log');
      match.toString = () => {
        throw new Error('nope');
      };

      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(a, old, old);

      expect(() =>
        manager.applyRetentionOnce(
          dir,
          { maxFiles: 1, match },
          { nowMs: 0, minIntervalMs: 0 }
        )
      ).not.toThrow();
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(true);
    });
  });

  test('applyRetentionOnce re-runs within the interval when entry count changes', async () => {
    await withTempCwd('retention-manager-count-change', async (cwd) => {
      const manager = await import('@/utils/logging/retention-manager.ts');
      manager.resetRetentionState();

      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const files = ['a.log', 'b.log', 'c.log'];
      files.forEach((f, i) => {
        const p = path.join(dir, f);
        fs.writeFileSync(p, f);
        const when = new Date(Date.now() - (files.length - i) * 1000);
        fs.utimesSync(p, when, when);
      });

      manager.applyRetentionOnce(
        dir,
        {
          maxFiles: 3,
          includeDirs: false,
          match: (d) => d.isFile() && d.name.endsWith('.log')
        },
        { minIntervalMs: 1_000_000, nowMs: 0 }
      );

      // Add an extra file and call again quickly. The count change should force a run.
      const dPath = path.join(dir, 'd.log');
      fs.writeFileSync(dPath, 'd');
      const newest = new Date(Date.now() + 1000);
      fs.utimesSync(dPath, newest, newest);

      manager.applyRetentionOnce(
        dir,
        {
          maxFiles: 3,
          includeDirs: false,
          match: (d) => d.isFile() && d.name.endsWith('.log')
        },
        { minIntervalMs: 1_000_000, nowMs: 1 }
      );

      const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
      expect(remaining.length).toBe(3);
      expect(fs.existsSync(path.join(dir, 'a.log'))).toBe(false);
    });
  });

  test('applyRetentionOnce does not collide across different matchers', async () => {
    await withTempCwd('retention-manager-no-collide', async (cwd) => {
      const manager = await import('@/utils/logging/retention-manager.ts');
      manager.resetRetentionState();

      const dir = path.join(cwd, 'logs');
      fs.mkdirSync(dir, { recursive: true });

      const aLog = path.join(dir, 'a.log');
      const bLog = path.join(dir, 'b.log');
      const aTxt = path.join(dir, 'a.txt');
      const bTxt = path.join(dir, 'b.txt');

      fs.writeFileSync(aLog, 'a');
      fs.writeFileSync(bLog, 'b');
      fs.writeFileSync(aTxt, 'a');
      fs.writeFileSync(bTxt, 'b');

      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(aLog, old, old);
      fs.utimesSync(aTxt, old, old);

      // Prune logs
      manager.applyRetentionOnce(
        dir,
        {
          maxFiles: 1,
          includeDirs: false,
          match: (d) => d.isFile() && d.name.endsWith('.log')
        },
        { minIntervalMs: 1_000_000 }
      );
      expect(fs.existsSync(aLog)).toBe(false);
      expect(fs.existsSync(bLog)).toBe(true);

      // Prune txt (must NOT be deduped away due to key collision)
      manager.applyRetentionOnce(
        dir,
        {
          maxFiles: 1,
          includeDirs: false,
          match: (d) => d.isFile() && d.name.endsWith('.txt')
        },
        { minIntervalMs: 1_000_000 }
      );
      expect(fs.existsSync(aTxt)).toBe(false);
      expect(fs.existsSync(bTxt)).toBe(true);
    });
  });
});
