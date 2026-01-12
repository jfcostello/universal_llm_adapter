import fs from 'fs';
import path from 'path';

import {
  deepMerge,
  getAdapterPathsConfig,
  isPlainObject,
  loadJsonFile,
  PACKAGE_ROOT
} from '../../../kernel/index.js';
import { assertValidExtensionName } from '../../shared/index.js';

export type ExtensionSourceKind = 'builtin' | 'external';

export interface ResolvedExtensionEntry {
  name: string;
  kind: ExtensionSourceKind;
  root: string;
  entryFilePath: string;
  precedence: number;
}

function getPackRootsLowToHigh(): Array<{
  kind: ExtensionSourceKind;
  root: string;
  precedence: number;
}> {
  const pathsConfig = getAdapterPathsConfig();
  const cfg = pathsConfig?.paths.lookup.extensions;

  const builtinEnabled = cfg?.builtin ?? true;
  const externalRoots = cfg?.externalRoots ?? [];

  const roots: Array<{ kind: ExtensionSourceKind; root: string; precedence: number }> = [];
  let precedence = 0;

  if (builtinEnabled) {
    roots.push({ kind: 'builtin', root: path.resolve(PACKAGE_ROOT), precedence: precedence++ });
  }
  for (const externalRoot of externalRoots) {
    roots.push({ kind: 'external', root: path.resolve(externalRoot), precedence: precedence++ });
  }

  const unique: Array<{ kind: ExtensionSourceKind; root: string; precedence: number }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.root)) continue;
    seen.add(root.root);
    unique.push(root);
  }

  return unique;
}

function resolveExtensionEntryInRoot(root: string, name: string): string | undefined {
  const dir = path.join(root, 'extensions', name);
  const js = path.join(dir, 'index.js');
  const ts = path.join(dir, 'index.ts');

  if (fs.existsSync(js)) return js;
  if (fs.existsSync(ts)) return ts;
  return undefined;
}

function warnOnOverride(name: string, previous: ResolvedExtensionEntry, next: ResolvedExtensionEntry): void {
  const pathsConfig = getAdapterPathsConfig();
  if (!pathsConfig?.paths.lookup.warnOnOverride) return;

  try {
    console.warn('extensions.override', {
      name,
      previous: {
        kind: previous.kind,
        root: previous.root,
        filePath: previous.entryFilePath,
        precedence: previous.precedence
      },
      next: {
        kind: next.kind,
        root: next.root,
        filePath: next.entryFilePath,
        precedence: next.precedence
      }
    });
  } catch {}
}

function warnOnMissingRoot(root: { kind: ExtensionSourceKind; root: string }): void {
  try {
    console.warn('extensions.root_missing', { kind: root.kind, root: root.root });
  } catch {}
}

export function resolveExtensionEntry(name: unknown): ResolvedExtensionEntry | undefined {
  const safeName = assertValidExtensionName(name);
  const roots = getPackRootsLowToHigh();

  let resolved: ResolvedExtensionEntry | undefined;

  for (const root of roots) {
    if (!fs.existsSync(root.root)) {
      if (root.kind !== 'builtin') {
        warnOnMissingRoot(root);
      }
      continue;
    }

    const entryFilePath = resolveExtensionEntryInRoot(root.root, safeName);
    if (!entryFilePath) continue;

    const next: ResolvedExtensionEntry = {
      name: safeName,
      kind: root.kind,
      root: root.root,
      entryFilePath,
      precedence: root.precedence
    };

    if (resolved) {
      warnOnOverride(safeName, resolved, next);
    }

    resolved = next;
  }

  return resolved;
}

export function listExtensions(): ResolvedExtensionEntry[] {
  const roots = getPackRootsLowToHigh();
  const resolvedByName = new Map<string, ResolvedExtensionEntry>();

  for (const root of roots) {
    if (!fs.existsSync(root.root)) {
      if (root.kind !== 'builtin') {
        warnOnMissingRoot(root);
      }
      continue;
    }

    const extensionsDir = path.join(root.root, 'extensions');
    if (!fs.existsSync(extensionsDir)) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      let extName: string;
      try {
        extName = assertValidExtensionName(entry.name);
      } catch {
        continue;
      }

      const entryFilePath = resolveExtensionEntryInRoot(root.root, extName);
      if (!entryFilePath) continue;

      const next: ResolvedExtensionEntry = {
        name: extName,
        kind: root.kind,
        root: root.root,
        entryFilePath,
        precedence: root.precedence
      };

      const previous = resolvedByName.get(extName);
      if (previous) {
        warnOnOverride(extName, previous, next);
      }

      resolvedByName.set(extName, next);
    }
  }

  return Array.from(resolvedByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadExtensionDefaults(ext: ResolvedExtensionEntry): Record<string, any> | undefined {
  const filePath = path.join(ext.root, 'extensions', ext.name, 'defaults.json');
  if (!fs.existsSync(filePath)) return undefined;

  try {
    const raw = loadJsonFile(filePath);
    return isPlainObject(raw) ? raw : undefined;
  } catch (err: any) {
    try {
      console.warn('extensions.defaults_invalid', { name: ext.name, filePath, error: String(err) });
    } catch {}
    return undefined;
  }
}

export function mergeExtensionConfig(
  defaultsConfig: unknown,
  legacyConfig: unknown
): Record<string, any> | undefined {
  if (legacyConfig === undefined) {
    return isPlainObject(defaultsConfig) ? defaultsConfig : undefined;
  }

  if (isPlainObject(defaultsConfig) && isPlainObject(legacyConfig)) {
    return deepMerge(defaultsConfig, legacyConfig);
  }

  return isPlainObject(legacyConfig) ? legacyConfig : undefined;
}
