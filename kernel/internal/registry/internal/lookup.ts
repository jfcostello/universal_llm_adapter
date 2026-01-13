import * as fs from 'fs';
import * as path from 'path';

import { normalizeExternalRoots } from '../../normalize-external-roots.js';
import { PACKAGE_ROOT } from '../../paths.js';

import type {
  ManifestSourceMeta,
  PluginRegistryLookupAreaConfig,
  PluginRegistryLookupConfig,
  PluginRegistrySourceKind
} from './public-types.js';
import type { NormalizedPluginRegistryLookupConfig, PluginRegistryState } from './state.js';

const distRoot = PACKAGE_ROOT;

export function normalizeLookupConfig(cwd: string, lookup?: PluginRegistryLookupConfig): NormalizedPluginRegistryLookupConfig {
  const externalRoots = normalizeExternalRoots(cwd, lookup?.externalRoots);

  const areas: Record<string, PluginRegistryLookupAreaConfig> = {};
  if (lookup?.areas && typeof lookup.areas === 'object') {
    for (const [key, value] of Object.entries(lookup.areas)) {
      if (!key || typeof value !== 'object' || !value) continue;

      const areaExternal = Array.isArray((value as any).externalRoots) ? (value as any).externalRoots : undefined;
      areas[key] = {
        ...(typeof (value as any).builtinManifests === 'boolean' ? { builtinManifests: Boolean((value as any).builtinManifests) } : {}),
        ...(typeof (value as any).builtinCode === 'boolean' ? { builtinCode: Boolean((value as any).builtinCode) } : {}),
        ...(typeof (value as any).local === 'boolean' ? { local: Boolean((value as any).local) } : {}),
        ...(areaExternal
          ? {
              externalRoots: normalizeExternalRoots(cwd, areaExternal)
            }
          : {})
      };
    }
  }

  return {
    warnOnOverride: typeof lookup?.warnOnOverride === 'boolean' ? Boolean(lookup.warnOnOverride) : true,
    base: {
      builtinManifests: typeof lookup?.builtinManifests === 'boolean' ? Boolean(lookup.builtinManifests) : false,
      builtinCode: typeof lookup?.builtinCode === 'boolean' ? Boolean(lookup.builtinCode) : true,
      local: typeof lookup?.local === 'boolean' ? Boolean(lookup.local) : true,
      externalRoots
    },
    areas
  };
}

export function getLookupAreaConfig(
  state: PluginRegistryState,
  area: string
): Required<Pick<PluginRegistryLookupAreaConfig, 'builtinManifests' | 'builtinCode' | 'local' | 'externalRoots'>> {
  const fallback: Required<Pick<PluginRegistryLookupAreaConfig, 'builtinManifests' | 'builtinCode' | 'local' | 'externalRoots'>> =
    state.lookup?.base ?? { builtinManifests: false, builtinCode: true, local: true, externalRoots: [] };
  const override = state.lookup?.areas?.[area];
  if (!override) return fallback;

  return {
    builtinManifests: typeof override.builtinManifests === 'boolean' ? Boolean(override.builtinManifests) : fallback.builtinManifests,
    builtinCode: typeof override.builtinCode === 'boolean' ? Boolean(override.builtinCode) : fallback.builtinCode,
    local: typeof override.local === 'boolean' ? Boolean(override.local) : fallback.local,
    externalRoots: Array.isArray(override.externalRoots) ? override.externalRoots : fallback.externalRoots
  };
}

export function getPackRootsLowToHigh(
  state: PluginRegistryState,
  area: string,
  purpose: 'manifests' | 'code'
): Array<{ kind: PluginRegistrySourceKind; root: string; precedence: number }> {
  if (state.mode === 'legacy') {
    // Legacy mode: the registry is rooted at `rootPath` only for manifests. Code roots are handled separately.
    return [{ kind: 'local', root: state.rootPath, precedence: 1 }];
  }

  const cfg = getLookupAreaConfig(state, area);
  const builtinEnabled = purpose === 'manifests' ? cfg.builtinManifests : cfg.builtinCode;
  const roots: Array<{ kind: PluginRegistrySourceKind; root: string; precedence: number }> = [];

  const builtinRoot = path.resolve(distRoot, 'plugins');
  const localRoot = state.rootPath;

  let precedence = 0;
  if (builtinEnabled) {
    roots.push({ kind: 'builtin', root: builtinRoot, precedence: precedence++ });
  }
  if (cfg.local) {
    roots.push({ kind: 'local', root: localRoot, precedence: precedence++ });
  }
  for (const externalRoot of cfg.externalRoots) {
    roots.push({ kind: 'external', root: externalRoot, precedence: precedence++ });
  }

  // Missing roots are ignored (hot-swappable by design).
  return roots.filter(r => fs.existsSync(r.root));
}

function makeManifestSourceKey(area: string, id: string): string {
  return `${area}:${id}`;
}

export function getManifestSource(state: PluginRegistryState, area: string, id: string): ManifestSourceMeta | undefined {
  return state.manifestSources.get(makeManifestSourceKey(area, id));
}

export function warnOnOverride(
  state: PluginRegistryState,
  area: string,
  id: string,
  previous: ManifestSourceMeta,
  next: ManifestSourceMeta
): void {
  if (!state.lookup?.warnOnOverride) return;
  try {
    console.warn('plugin_registry.override', {
      area,
      id,
      previous: { kind: previous.kind, root: previous.root, filePath: previous.filePath, precedence: previous.precedence },
      next: { kind: next.kind, root: next.root, filePath: next.filePath, precedence: next.precedence }
    });
  } catch {}
}

export function setManifestSource(state: PluginRegistryState, area: string, id: string, source: ManifestSourceMeta): void {
  state.manifestSources.set(makeManifestSourceKey(area, id), source);
}

