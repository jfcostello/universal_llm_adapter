import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveModuleEntryInRoot } from '@/kernel/index.ts';

describe('kernel/fs-module-entry', () => {
  describe('resolveModuleEntryInRoot', () => {
    test('resolves index.js in a module directory', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-module-entry-'));
      try {
        const moduleDir = path.join(tmp, 'my-module');
        fs.mkdirSync(moduleDir, { recursive: true });
        fs.writeFileSync(path.join(moduleDir, 'index.js'), 'module.exports = {};');

        const result = resolveModuleEntryInRoot(tmp, 'my-module');
        expect(result).toBe(path.join(moduleDir, 'index.js'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('resolves single-file module (.js)', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-module-entry-'));
      try {
        fs.writeFileSync(path.join(tmp, 'single.js'), 'module.exports = {};');

        const result = resolveModuleEntryInRoot(tmp, 'single');
        expect(result).toBe(path.join(tmp, 'single.js'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns undefined when module not found', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-module-entry-'));
      try {
        const result = resolveModuleEntryInRoot(tmp, 'missing');
        expect(result).toBeUndefined();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
