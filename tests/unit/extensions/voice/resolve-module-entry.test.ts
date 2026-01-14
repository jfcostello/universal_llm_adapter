import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveModuleEntryAcrossRoots } from '@/extensions/voice/modules/provider-plugins/internal/resolve-module-entry.ts';

describe('extensions/voice/resolve-module-entry', () => {
  describe('resolveModuleEntryAcrossRoots', () => {
    test('returns first matching module across roots', () => {
      const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root1-'));
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root2-'));
      try {
        // Create module only in second root
        const compatDir = path.join(tmp2, 'compat', 'my-compat');
        fs.mkdirSync(compatDir, { recursive: true });
        fs.writeFileSync(path.join(compatDir, 'index.js'), 'module.exports = {};');

        const result = resolveModuleEntryAcrossRoots([tmp1, tmp2], 'compat', 'my-compat');
        expect(result).toBe(path.join(compatDir, 'index.js'));
      } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    });

    test('returns first match when module exists in multiple roots', () => {
      const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root1-'));
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root2-'));
      try {
        // Create module in both roots
        const compatDir1 = path.join(tmp1, 'compat', 'shared-compat');
        const compatDir2 = path.join(tmp2, 'compat', 'shared-compat');
        fs.mkdirSync(compatDir1, { recursive: true });
        fs.mkdirSync(compatDir2, { recursive: true });
        fs.writeFileSync(path.join(compatDir1, 'index.js'), 'module.exports = { root: 1 };');
        fs.writeFileSync(path.join(compatDir2, 'index.js'), 'module.exports = { root: 2 };');

        // First root should win
        const result = resolveModuleEntryAcrossRoots([tmp1, tmp2], 'compat', 'shared-compat');
        expect(result).toBe(path.join(compatDir1, 'index.js'));
      } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    });

    test('skips non-existent roots', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-'));
      try {
        const compatDir = path.join(tmp, 'compat', 'my-compat');
        fs.mkdirSync(compatDir, { recursive: true });
        fs.writeFileSync(path.join(compatDir, 'index.js'), 'module.exports = {};');

        const missingRoot = path.join(os.tmpdir(), 'non-existent-root-xyz');
        const result = resolveModuleEntryAcrossRoots([missingRoot, tmp], 'compat', 'my-compat');
        expect(result).toBe(path.join(compatDir, 'index.js'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('skips roots where subdir does not exist', () => {
      const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root1-'));
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root2-'));
      try {
        // tmp1 exists but has no 'compat' subdir
        // tmp2 has the module
        const compatDir = path.join(tmp2, 'compat', 'my-compat');
        fs.mkdirSync(compatDir, { recursive: true });
        fs.writeFileSync(path.join(compatDir, 'index.js'), 'module.exports = {};');

        const result = resolveModuleEntryAcrossRoots([tmp1, tmp2], 'compat', 'my-compat');
        expect(result).toBe(path.join(compatDir, 'index.js'));
      } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    });

    test('returns undefined when module not found in any root', () => {
      const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root1-'));
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-root2-'));
      try {
        // Create compat dirs but not the module we're looking for
        fs.mkdirSync(path.join(tmp1, 'compat'), { recursive: true });
        fs.mkdirSync(path.join(tmp2, 'compat'), { recursive: true });

        const result = resolveModuleEntryAcrossRoots([tmp1, tmp2], 'compat', 'missing-module');
        expect(result).toBeUndefined();
      } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    });

    test('handles empty roots array', () => {
      const result = resolveModuleEntryAcrossRoots([], 'compat', 'any-module');
      expect(result).toBeUndefined();
    });

    test('resolves single-file module (.js)', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-'));
      try {
        const compatDir = path.join(tmp, 'compat');
        fs.mkdirSync(compatDir, { recursive: true });
        fs.writeFileSync(path.join(compatDir, 'single.js'), 'module.exports = {};');

        const result = resolveModuleEntryAcrossRoots([tmp], 'compat', 'single');
        expect(result).toBe(path.join(compatDir, 'single.js'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('resolves .ts files', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-module-'));
      try {
        const compatDir = path.join(tmp, 'compat', 'ts-module');
        fs.mkdirSync(compatDir, { recursive: true });
        fs.writeFileSync(path.join(compatDir, 'index.ts'), 'export default {};');

        const result = resolveModuleEntryAcrossRoots([tmp], 'compat', 'ts-module');
        expect(result).toBe(path.join(compatDir, 'index.ts'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
