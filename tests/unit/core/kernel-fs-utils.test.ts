import fs from 'fs';
import os from 'os';
import path from 'path';

import { normalizeExternalRoots, resolveModuleEntryInRoot } from '@/kernel/index.ts';

describe('kernel/fs utils', () => {
  describe('resolveModuleEntryInRoot', () => {
    test('prefers <root>/<name>/index.js over single-file module', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-module-entry-'));
      try {
        fs.mkdirSync(path.join(root, 'foo'), { recursive: true });
        fs.writeFileSync(path.join(root, 'foo', 'index.js'), 'export default {}', 'utf-8');
        fs.writeFileSync(path.join(root, 'foo.js'), 'export default {}', 'utf-8');

        expect(resolveModuleEntryInRoot(root, 'foo')).toBe(path.join(root, 'foo', 'index.js'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('falls back to <root>/<name>.ts when no index.(js|ts) exists', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-module-entry-'));
      try {
        fs.writeFileSync(path.join(root, 'bar.ts'), 'export default {}', 'utf-8');

        expect(resolveModuleEntryInRoot(root, 'bar')).toBe(path.join(root, 'bar.ts'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('returns undefined when no entry exists', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-module-entry-'));
      try {
        expect(resolveModuleEntryInRoot(root, 'nope')).toBeUndefined();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('normalizeExternalRoots', () => {
    test('dedupes, trims, and resolves relative roots against cwd', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-external-roots-'));
      try {
        const roots = normalizeExternalRoots(cwd, ['  ./a  ', './a', '../b', '', 123]);
        expect(roots).toEqual([
          path.resolve(cwd, './a'),
          path.resolve(cwd, '../b')
        ]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

