import * as fs from 'fs';
import * as path from 'path';
import type { RetentionOptions } from './retention.js';
import { enforceRetention } from './retention.js';

export interface ApplyRetentionOnceOptions {
  /**
   * Minimum time between retention runs for the same policy key.
   * This prevents high-frequency callers from repeatedly scanning/deleting the same directory.
   */
  minIntervalMs?: number;

  /**
   * Override for testing.
   */
  nowMs?: number;
}

const lastAppliedByKey = new Map<string, { atMs: number; count: number }>();

function getMatchKey(opts: RetentionOptions): string {
  if (!opts.match) return 'default';
  try {
    return String(opts.match);
  } catch {
    return 'match';
  }
}

function createPolicyKey(dir: string, opts: RetentionOptions): string {
  const resolvedDir = path.resolve(dir);
  const includeDirs = Boolean(opts.includeDirs);
  const maxFiles = Math.max(0, Math.floor(opts.maxFiles));
  const maxAgeDays = typeof opts.maxAgeDays === 'number' ? opts.maxAgeDays : null;
  const match = getMatchKey(opts);

  // Intentionally exclude `exclude` from the key: exclude paths often include the
  // active log file/dir, which would defeat dedupe while still providing little
  // safety beyond “keep newest N”.
  return JSON.stringify({ dir: resolvedDir, includeDirs, maxFiles, maxAgeDays, match });
}

function countMatchingEntries(dir: string, opts: RetentionOptions): number {
  if (!fs.existsSync(dir)) return 0;

  const includeDirs = Boolean(opts.includeDirs);
  const match =
    opts.match ??
    ((d: fs.Dirent) => (includeDirs ? d.isDirectory() : d.isFile()));

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => (includeDirs ? (d.isDirectory() || d.isFile()) : d.isFile()))
    .filter(d => match(d))
    .length;
}

export function applyRetentionOnce(
  dir: string,
  opts: RetentionOptions,
  options: ApplyRetentionOnceOptions = {}
): string[] {
  const key = createPolicyKey(dir, opts);
  const now = options.nowMs ?? Date.now();
  const minIntervalMs = options.minIntervalMs ?? 1000;

  const currentCount = countMatchingEntries(dir, opts);
  const last = lastAppliedByKey.get(key);
  if (
    last &&
    now - last.atMs < minIntervalMs &&
    currentCount === last.count
  ) {
    return [];
  }

  const deleted = enforceRetention(dir, opts);
  const afterCount = countMatchingEntries(dir, opts);
  lastAppliedByKey.set(key, { atMs: now, count: afterCount });
  return deleted;
}

export function resetRetentionState(): void {
  lastAppliedByKey.clear();
}
