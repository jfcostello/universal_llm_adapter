import fs from 'fs';
import * as path from 'path';

export interface RetentionOptions {
  // Keep at most this many matching entries (files or dirs)
  maxFiles: number;
  // Optionally delete items older than this many days
  maxAgeDays?: number;
  // Include directories in matching set (default false = files only)
  includeDirs?: boolean;
  // Exclude these absolute paths from deletion
  exclude?: string[];
  // Predicate to select entries; if omitted selects all files (and dirs if includeDirs)
  match?: (entry: fs.Dirent) => boolean;
}

export function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readEnvFloat(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Enforce retention policy within a directory by keeping only the newest N entries
 * (and optionally deleting entries older than maxAgeDays).
 * - Selection is based on `match` predicate and `includeDirs` flag.
 * - Newest is determined by mtimeMs; ties fall back to name ascending.
 * - Excluded absolute paths are never deleted.
 * Returns the list of deleted absolute paths for observability/testing.
 */
export function enforceRetention(dir: string, opts: RetentionOptions): string[] {
  const deleted: string[] = [];
  if (!fs.existsSync(dir)) return deleted;

  const includeDirs = Boolean(opts.includeDirs);
  const exclude = new Set((opts.exclude ?? []).map(p => path.resolve(p)));
  const match = opts.match ?? ((d: fs.Dirent) => (includeDirs ? d.isDirectory() : d.isFile()));
  const now = Date.now();
  const maxAgeMs = opts.maxAgeDays ? opts.maxAgeDays * 24 * 60 * 60 * 1000 : undefined;

  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => (includeDirs ? (d.isDirectory() || d.isFile()) : d.isFile()))
    .filter(d => match(d))
    .map(d => {
      const full = path.join(dir, d.name);
      try {
        const stat = fs.statSync(full);
        return { name: d.name, full, isDir: d.isDirectory(), mtimeMs: stat.mtimeMs };
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Time-based trimming first
  if (typeof maxAgeMs === 'number') {
    for (const e of entries) {
      if (exclude.has(path.resolve(e.full))) continue;
      if (now - e.mtimeMs > maxAgeMs) {
        removePath(e.full, e.isDir);
        deleted.push(e.full);
      }
    }
  }

  // Refresh entries after time-based deletion
  const remaining = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => (includeDirs ? (d.isDirectory() || d.isFile()) : d.isFile()))
    .filter(d => match(d))
    .map(d => {
      const full = path.join(dir, d.name);
      try {
        const stat = fs.statSync(full);
        return { name: d.name, full, isDir: d.isDirectory(), mtimeMs: stat.mtimeMs };
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));

  const toKeep = Math.max(0, opts.maxFiles);
  const survivors: string[] = [];
  for (const e of remaining) {
    const full = path.resolve(e.full);
    if (exclude.has(full)) {
      survivors.push(full);
      continue;
    }
    if (survivors.length < toKeep) {
      survivors.push(full);
      continue;
    }
    removePath(full, e.isDir);
    deleted.push(full);
  }

  return deleted;
}

function removePath(target: string, isDir: boolean) {
  try {
    if (isDir) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.rmSync(target, { force: true });
    }
  } catch {
    // best-effort; ignore failures
  }
}
