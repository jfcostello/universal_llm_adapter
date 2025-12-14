import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const MODULES_DIR = path.join(ROOT_DIR, 'modules');

const OPTIONAL_MODULES = new Set([
  'tools',
  'mcp',
  'vector',
  'embeddings',
  'logging'
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(abs, out);
      continue;
    }
    if (entry.isFile() && abs.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function getImporterModule(filePath: string): string | null {
  const rel = path.relative(MODULES_DIR, filePath);
  const [moduleName] = rel.split(path.sep);
  return moduleName || null;
}

function getTargetModule(importerFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const resolved = path.resolve(path.dirname(importerFile), specifier).replaceAll('\\', '/');
  const marker = '/modules/';
  const idx = resolved.lastIndexOf(marker);
  if (idx === -1) {
    return null;
  }

  const after = resolved.slice(idx + marker.length);
  const [moduleName] = after.split('/');
  return moduleName || null;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;

  if (clause.name) {
    return false;
  }

  if (!clause.namedBindings) {
    return false;
  }

  if (ts.isNamespaceImport(clause.namedBindings)) {
    return false;
  }

  // `import { type A } from 'x'` is fully type-only and should not count as runtime.
  return clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every(el => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause) return false;
  if (ts.isNamespaceExport(node.exportClause)) return false;
  return node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every(el => el.isTypeOnly);
}

function getSpecifierText(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    if (spec && ts.isStringLiteralLike(spec)) {
      return spec.text;
    }
    return null;
  }

  if (ts.isImportEqualsDeclaration(node)) {
    const ref = node.moduleReference;
    if (ts.isExternalModuleReference(ref)) {
      const expr = ref.expression;
      if (expr && ts.isStringLiteralLike(expr)) {
        return expr.text;
      }
    }
  }

  return null;
}

describe('guardrails/lazy-loading (static imports)', () => {
  test('no runtime static imports of optional modules across module boundaries', () => {
    const files = walkTsFiles(MODULES_DIR);
    const offenders: Array<{
      file: string;
      importerModule: string;
      specifier: string;
      targetModule: string;
      kind: 'import' | 'export' | 'import=';
    }> = [];

    for (const file of files) {
      const importerModule = getImporterModule(file);
      if (!importerModule) continue;

      const sourceText = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      for (const statement of sf.statements) {
        if (ts.isImportDeclaration(statement)) {
          const specifier = getSpecifierText(statement);
          if (!specifier) continue;
          if (isTypeOnlyImport(statement)) continue;
          if (!statement.importClause) {
            // Side-effect import: `import 'x'`
            const targetModule = getTargetModule(file, specifier);
            if (targetModule && OPTIONAL_MODULES.has(targetModule) && targetModule !== importerModule) {
              offenders.push({
                file: path.relative(ROOT_DIR, file).replaceAll(path.sep, '/'),
                importerModule,
                specifier,
                targetModule,
                kind: 'import'
              });
            }
            continue;
          }

          const targetModule = getTargetModule(file, specifier);
          if (targetModule && OPTIONAL_MODULES.has(targetModule) && targetModule !== importerModule) {
            offenders.push({
              file: path.relative(ROOT_DIR, file).replaceAll(path.sep, '/'),
              importerModule,
              specifier,
              targetModule,
              kind: 'import'
            });
          }
          continue;
        }

        if (ts.isExportDeclaration(statement)) {
          const specifier = getSpecifierText(statement);
          if (!specifier) continue;
          if (isTypeOnlyExport(statement)) continue;

          const targetModule = getTargetModule(file, specifier);
          if (targetModule && OPTIONAL_MODULES.has(targetModule) && targetModule !== importerModule) {
            offenders.push({
              file: path.relative(ROOT_DIR, file).replaceAll(path.sep, '/'),
              importerModule,
              specifier,
              targetModule,
              kind: 'export'
            });
          }
          continue;
        }

        if (ts.isImportEqualsDeclaration(statement)) {
          const specifier = getSpecifierText(statement);
          if (!specifier) continue;

          const targetModule = getTargetModule(file, specifier);
          if (targetModule && OPTIONAL_MODULES.has(targetModule) && targetModule !== importerModule) {
            offenders.push({
              file: path.relative(ROOT_DIR, file).replaceAll(path.sep, '/'),
              importerModule,
              specifier,
              targetModule,
              kind: 'import='
            });
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

