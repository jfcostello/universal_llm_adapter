import fs from 'fs';
import path from 'path';
import { resolveFixture } from './paths.ts';

export function copyFixturePlugins(targetDir: string, variant = 'basic'): string {
  const sourceDir = resolveFixture('plugins', variant);
  copyDirectory(sourceDir, targetDir);
  return targetDir;
}

export function copyDirectory(source: string, destination: string): void {
  const entries = fs.readdirSync(source, { withFileTypes: true });
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
