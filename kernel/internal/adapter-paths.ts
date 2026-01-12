import * as fs from 'fs';
import * as path from 'path';
import { loadJsonFile } from './config.js';
import { isPlainObject } from './deep-merge.js';

export type AdapterPathsConfigSource = 'env' | 'cwd' | 'walk-up';

export interface AdapterPathsConfigLookupAreaOverride {
  builtinManifests?: boolean;
  builtinCode?: boolean;
  local?: boolean;
  externalRoots?: string[];
}

export interface AdapterPathsConfig {
  filePath: string;
  source: AdapterPathsConfigSource;
  paths: {
    plugins?: string;
    lookup: {
      warnOnOverride: boolean;
      extensions: {
        builtin: boolean;
        externalRoots: string[];
      };
      plugins: {
        builtinManifests: boolean;
        builtinCode: boolean;
        local: boolean;
        externalRoots: string[];
        areas: Record<string, AdapterPathsConfigLookupAreaOverride>;
      };
      configs: {
        defaults: {
          builtin: boolean;
          local: boolean;
          externalRoots: string[];
        };
        usageCosts: {
          builtin: boolean;
          local: boolean;
          externalRoots: string[];
        };
      };
    };
  };
}

const PATHS_FILE_NAME = 'llm-adapter.paths.json';
const PATHS_FILE_ENV_VAR = 'LLM_ADAPTER_PATHS_FILE';

let cached: AdapterPathsConfig | null | undefined;
let cachedCwd: string | undefined;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeExternalRoots(cwd: string, raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const s = normalizeString(item);
    if (!s) continue;
    const resolved = path.isAbsolute(s) ? s : path.resolve(cwd, s);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function normalizeAreaOverride(cwd: string, value: unknown): AdapterPathsConfigLookupAreaOverride | undefined {
  if (!isPlainObject(value)) return undefined;

  const out: AdapterPathsConfigLookupAreaOverride = {};

  if ('builtinManifests' in value && typeof (value as any).builtinManifests === 'boolean') {
    out.builtinManifests = Boolean((value as any).builtinManifests);
  }
  if ('builtinCode' in value && typeof (value as any).builtinCode === 'boolean') {
    out.builtinCode = Boolean((value as any).builtinCode);
  }
  if ('local' in value && typeof (value as any).local === 'boolean') {
    out.local = Boolean((value as any).local);
  }
  if ('externalRoots' in value) {
    out.externalRoots = normalizeExternalRoots(cwd, (value as any).externalRoots);
  }

  return Object.keys(out).length ? out : undefined;
}

function normalizeConfig(cwd: string, raw: unknown): Omit<AdapterPathsConfig, 'filePath' | 'source'> {
  const root = isPlainObject(raw) ? raw : {};
  const pathsRaw = isPlainObject(root.paths) ? root.paths : {};
  const lookupRaw = isPlainObject(pathsRaw.lookup) ? pathsRaw.lookup : {};

  const extensionsRaw = isPlainObject(lookupRaw.extensions) ? lookupRaw.extensions : {};
  const pluginsRaw = isPlainObject(lookupRaw.plugins) ? lookupRaw.plugins : {};
  const configsRaw = isPlainObject(lookupRaw.configs) ? lookupRaw.configs : {};
  const defaultsRaw = isPlainObject(configsRaw.defaults) ? configsRaw.defaults : {};
  const usageCostsRaw = isPlainObject(configsRaw.usageCosts) ? configsRaw.usageCosts : {};

  const areasRaw = isPlainObject(pluginsRaw.areas) ? pluginsRaw.areas : {};
  const areas: Record<string, AdapterPathsConfigLookupAreaOverride> = {};

  for (const [areaName, areaValue] of Object.entries(areasRaw)) {
    const safeName = normalizeString(areaName);
    if (!safeName) continue;
    const normalized = normalizeAreaOverride(cwd, areaValue);
    if (normalized) {
      areas[safeName] = normalized;
    }
  }

  return {
    paths: {
      plugins: normalizeString(pathsRaw.plugins),
      lookup: {
        warnOnOverride: normalizeBoolean(lookupRaw.warnOnOverride, true),
        extensions: {
          builtin: normalizeBoolean(extensionsRaw.builtin, true),
          externalRoots: normalizeExternalRoots(cwd, extensionsRaw.externalRoots)
        },
        plugins: {
          builtinManifests: normalizeBoolean(pluginsRaw.builtinManifests, false),
          builtinCode: normalizeBoolean(pluginsRaw.builtinCode, true),
          local: normalizeBoolean(pluginsRaw.local, true),
          externalRoots: normalizeExternalRoots(cwd, pluginsRaw.externalRoots),
          areas
        },
        configs: {
          defaults: {
            builtin: normalizeBoolean(defaultsRaw.builtin, true),
            local: normalizeBoolean(defaultsRaw.local, true),
            externalRoots: normalizeExternalRoots(cwd, defaultsRaw.externalRoots)
          },
          usageCosts: {
            builtin: normalizeBoolean(usageCostsRaw.builtin, true),
            local: normalizeBoolean(usageCostsRaw.local, true),
            externalRoots: normalizeExternalRoots(cwd, usageCostsRaw.externalRoots)
          }
        }
      }
    }
  };
}

function resolvePathsFileFromEnv(cwd: string): string | null {
  const raw = normalizeString(process.env[PATHS_FILE_ENV_VAR]);
  if (!raw) return null;

  const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  if (fs.existsSync(resolved)) return resolved;

  try {
    console.warn('adapter_paths.env_file_missing', { envVar: PATHS_FILE_ENV_VAR, filePath: resolved });
  } catch {}

  return null;
}

function resolvePathsFileBySearch(cwd: string): { filePath: string; source: AdapterPathsConfigSource } | null {
  const envPath = resolvePathsFileFromEnv(cwd);
  if (envPath) {
    return { filePath: envPath, source: 'env' };
  }

  const cwdCandidate = path.join(cwd, PATHS_FILE_NAME);
  if (fs.existsSync(cwdCandidate)) {
    return { filePath: cwdCandidate, source: 'cwd' };
  }

  let current = cwd;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    const candidate = path.join(current, PATHS_FILE_NAME);
    if (fs.existsSync(candidate)) {
      return { filePath: candidate, source: 'walk-up' };
    }
  }

  return null;
}

export function resetAdapterPathsConfigCache(): void {
  cached = undefined;
  cachedCwd = undefined;
}

export function getAdapterPathsConfig(): AdapterPathsConfig | null {
  const cwd = process.cwd();

  if (cached !== undefined && cachedCwd === cwd) {
    return cached;
  }

  // Invalidate cache if process.cwd() changes (common in unit tests and CLIs).
  cached = undefined;
  cachedCwd = undefined;

  const resolved = resolvePathsFileBySearch(cwd);
  if (!resolved) {
    cached = null;
    cachedCwd = cwd;
    return cached;
  }

  try {
    const raw = loadJsonFile(resolved.filePath);
    const normalized = normalizeConfig(cwd, raw);
    cached = { filePath: resolved.filePath, source: resolved.source, ...normalized };
    cachedCwd = cwd;
    return cached;
  } catch (err: any) {
    try {
      console.warn('adapter_paths.file_invalid', { filePath: resolved.filePath, error: String(err) });
    } catch {}

    cached = null;
    cachedCwd = cwd;
    return cached;
  }
}
