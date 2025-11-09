import fs from 'fs';
import os from 'os';
import path from 'path';
import { getTmpRoot } from './paths.ts';

export function createTempDir(prefix: string): string {
  const root = getTmpRoot();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

export async function withTempCwd<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = createTempDir(prefix);
  const previous = process.cwd();
  process.chdir(dir);

  try {
    return await fn(dir);
  } finally {
    process.chdir(previous);
  }
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function createTempFile(prefix: string, content: string): string {
  const dir = createTempDir(prefix);
  const file = path.join(dir, 'temp.json');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}
