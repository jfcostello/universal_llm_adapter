import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

function walk(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function toRepoRelative(filePath: string): string {
  return path.relative(ROOT_DIR, filePath).replaceAll(path.sep, '/');
}

function extractImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];

  // Static imports/exports:
  //   import x from '...'
  //   import type { X } from '...'
  //   import '...'
  //   export * from '...'
  //   export { x } from '...'
  const staticRe = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (;;) {
    const match = staticRe.exec(sourceText);
    if (!match) break;
    specifiers.push(match[1]);
  }

  // Dynamic imports:
  //   await import('...')
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (;;) {
    const match = dynamicRe.exec(sourceText);
    if (!match) break;
    specifiers.push(match[1]);
  }

  return specifiers;
}

describe('guardrails/live-suite', () => {
  test('live tests never import internals or use mocks (golden rules)', () => {
    const liveDir = path.join(ROOT_DIR, 'tests', 'live', 'test-files');
    expect(fs.existsSync(liveDir)).toBe(true);

    const files = walk(liveDir)
      .filter(f => f.endsWith('.ts'));

    const offenders: Array<{ file: string; reason: string }> = [];

    for (const file of files) {
      const rel = toRepoRelative(file);
      const text = fs.readFileSync(file, 'utf8');

      const imports = extractImportSpecifiers(text);
      for (const spec of imports) {
        if (spec.startsWith('@/')) {
          offenders.push({ file: rel, reason: `Forbidden import specifier (internal): ${spec}` });
        }
        if (spec === 'llm-adapter' || spec.startsWith('llm-adapter/')) {
          offenders.push({ file: rel, reason: `Forbidden import specifier (programmatic API): ${spec}` });
        }
      }

      for (const needle of ['jest.fn(', 'jest.mock(', 'jest.spyOn(']) {
        if (text.includes(needle)) {
          offenders.push({ file: rel, reason: `Forbidden mock usage: ${needle}` });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

