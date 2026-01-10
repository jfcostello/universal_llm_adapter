import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { glob } from 'glob';
import { loadJsonFile } from './config.js';
import { PACKAGE_ROOT } from './paths.js';
import {
  ProviderManifest,
  RealtimeProviderManifest,
  UnifiedTool,
  MCPServerConfig,
  VectorStoreConfig,
  ProcessRouteManifest,
  ICompatModule,
  EmbeddingProviderConfig,
  IEmbeddingCompat,
  IVectorStoreCompat,
  ObservabilityProviderManifest,
  IObservabilityCompat
} from './types.js';
import type { IRealtimeCompat } from './realtime-types.js';
import { ManifestError } from './errors.js';

const distRoot = PACKAGE_ROOT;

export type PluginRegistrySourceKind = 'builtin' | 'local' | 'external';

export interface PluginRegistryLookupAreaConfig {
  builtinManifests?: boolean;
  builtinCode?: boolean;
  local?: boolean;
  externalRoots?: string[];
}

export interface PluginRegistryLookupConfig extends PluginRegistryLookupAreaConfig {
  warnOnOverride?: boolean;
  areas?: Record<string, PluginRegistryLookupAreaConfig>;
}

export interface PluginRegistryOptions {
  pluginsPath?: string;
  lookup?: PluginRegistryLookupConfig;
}

interface NormalizedPluginRegistryLookupConfig {
  warnOnOverride: boolean;
  base: Required<Pick<PluginRegistryLookupAreaConfig, 'builtinManifests' | 'builtinCode' | 'local' | 'externalRoots'>>;
  areas: Record<string, PluginRegistryLookupAreaConfig>;
}

interface ManifestSourceMeta {
  kind: PluginRegistrySourceKind;
  root: string;
  filePath: string;
  precedence: number;
}

export class PluginRegistry {
  private rootPath: string;
  private mode: 'legacy' | 'multi-root';
  private lookup: NormalizedPluginRegistryLookupConfig | null = null;
  private manifestSources = new Map<string, ManifestSourceMeta>();

  private providers = new Map<string, ProviderManifest>();
  private realtimeProviders = new Map<string, RealtimeProviderManifest>();
  private tools = new Map<string, UnifiedTool>();
  private mcpServers = new Map<string, MCPServerConfig>();
  private vectorStores = new Map<string, VectorStoreConfig>();
  private processRoutes: ProcessRouteManifest[] = [];
  private compatModules = new Map<string, () => ICompatModule>();
  private embeddingProviders = new Map<string, EmbeddingProviderConfig>();
  private embeddingCompats = new Map<string, () => IEmbeddingCompat>();
  private vectorStoreCompats = new Map<string, () => IVectorStoreCompat>();
  private realtimeCompats = new Map<string, () => IRealtimeCompat>();
  private observabilityProviders = new Map<string, ObservabilityProviderManifest>();
  private observabilityCompats = new Map<string, () => IObservabilityCompat>();

  // Lazy loading flags
  private providersLoaded = false;
  private realtimeProvidersLoaded = false;
  private toolsLoaded = false;
  private mcpServersLoaded = false;
  private vectorStoresLoaded = false;
  private processRoutesLoaded = false;
  private compatModulesLoaded = false;
  private embeddingProvidersLoaded = false;
  private embeddingCompatsLoaded = false;
  private vectorStoreCompatsLoaded = false;
  private realtimeCompatsLoaded = false;
  private observabilityProvidersLoaded = false;
  private observabilityCompatsLoaded = false;

  constructor(rootPath: string);
  constructor(options: PluginRegistryOptions);
  constructor(rootPathOrOptions: string | PluginRegistryOptions) {
    if (typeof rootPathOrOptions === 'string') {
      this.mode = 'legacy';
      this.rootPath = path.isAbsolute(rootPathOrOptions)
        ? rootPathOrOptions
        : path.resolve(process.cwd(), rootPathOrOptions);

      if (!fs.existsSync(this.rootPath)) {
        throw new ManifestError(`Plugin directory '${this.rootPath}' does not exist`);
      }
      return;
    }

    this.mode = 'multi-root';
    const cwd = process.cwd();
    const pluginsPath = (rootPathOrOptions.pluginsPath ?? './plugins').trim() || './plugins';
    this.rootPath = path.isAbsolute(pluginsPath) ? pluginsPath : path.resolve(cwd, pluginsPath);
    this.lookup = this.normalizeLookupConfig(cwd, rootPathOrOptions.lookup);
  }

  private normalizeLookupConfig(cwd: string, lookup?: PluginRegistryLookupConfig): NormalizedPluginRegistryLookupConfig {
    const baseExternal = Array.isArray(lookup?.externalRoots) ? lookup!.externalRoots : [];
    const externalRoots = baseExternal
      .map(v => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .map(v => (path.isAbsolute(v) ? v : path.resolve(cwd, v)));

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
                externalRoots: areaExternal
                  .map((v: unknown): string => (typeof v === 'string' ? v.trim() : ''))
                  .filter((v: string): v is string => Boolean(v))
                  .map((v: string) => (path.isAbsolute(v) ? v : path.resolve(cwd, v)))
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

  async loadAll(): Promise<void> {
    // Deprecated: kept for backward compatibility but does nothing
    // All loading is now lazy and on-demand
  }

  private getLookupAreaConfig(area: string): Required<Pick<PluginRegistryLookupAreaConfig, 'builtinManifests' | 'builtinCode' | 'local' | 'externalRoots'>> {
    const fallback: Required<Pick<PluginRegistryLookupAreaConfig, 'builtinManifests' | 'builtinCode' | 'local' | 'externalRoots'>> =
      this.lookup?.base ?? { builtinManifests: false, builtinCode: true, local: true, externalRoots: [] };
    const override = this.lookup?.areas?.[area];
    if (!override) return fallback;

    return {
      builtinManifests: typeof override.builtinManifests === 'boolean' ? Boolean(override.builtinManifests) : fallback.builtinManifests,
      builtinCode: typeof override.builtinCode === 'boolean' ? Boolean(override.builtinCode) : fallback.builtinCode,
      local: typeof override.local === 'boolean' ? Boolean(override.local) : fallback.local,
      externalRoots: Array.isArray(override.externalRoots) ? override.externalRoots : fallback.externalRoots
    };
  }

  private getPackRootsLowToHigh(area: string, purpose: 'manifests' | 'code'): Array<{ kind: PluginRegistrySourceKind; root: string; precedence: number }> {
    if (this.mode === 'legacy') {
      // Legacy mode: the registry is rooted at `rootPath` only for manifests. Code roots are handled separately.
      return [{ kind: 'local', root: this.rootPath, precedence: 1 }];
    }

    const cfg = this.getLookupAreaConfig(area);
    const builtinEnabled = purpose === 'manifests' ? cfg.builtinManifests : cfg.builtinCode;
    const roots: Array<{ kind: PluginRegistrySourceKind; root: string; precedence: number }> = [];

    const builtinRoot = path.resolve(distRoot, 'plugins');
    const localRoot = this.rootPath;

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

  private makeManifestSourceKey(area: string, id: string): string {
    return `${area}:${id}`;
  }

  getManifestSource(area: string, id: string): ManifestSourceMeta | undefined {
    return this.manifestSources.get(this.makeManifestSourceKey(area, id));
  }

  private warnOnOverride(area: string, id: string, previous: ManifestSourceMeta, next: ManifestSourceMeta): void {
    if (!this.lookup?.warnOnOverride) return;
    try {
      console.warn('plugin_registry.override', {
        area,
        id,
        previous: { kind: previous.kind, root: previous.root, filePath: previous.filePath, precedence: previous.precedence },
        next: { kind: next.kind, root: next.root, filePath: next.filePath, precedence: next.precedence }
      });
    } catch {}
  }

  private setManifestSource(area: string, id: string, source: ManifestSourceMeta): void {
    this.manifestSources.set(this.makeManifestSourceKey(area, id), source);
  }

  private getPluginCodeCandidates(area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat'): string[] {
    return [
      path.resolve(distRoot, 'plugins', area),
      path.join(this.rootPath, area),
      path.resolve(process.cwd(), 'plugins', area),
    ];
  }

  private resolvePluginCodeEntryInRoot(root: string, moduleName: string): string | undefined {
    // Prefer module directories: <root>/<name>/index.(js|ts)
    const dir = path.join(root, moduleName);
    const dirIndexJs = path.join(dir, 'index.js');
    const dirIndexTs = path.join(dir, 'index.ts');

    if (fs.existsSync(dirIndexJs)) return dirIndexJs;
    if (fs.existsSync(dirIndexTs)) return dirIndexTs;

    // Fall back to legacy single-file modules: <root>/<name>.(js|ts)
    const fileJs = path.join(root, `${moduleName}.js`);
    const fileTs = path.join(root, `${moduleName}.ts`);

    if (fs.existsSync(fileJs)) return fileJs;
    if (fs.existsSync(fileTs)) return fileTs;

    return undefined;
  }

  private resolvePluginCodeEntry(
    area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat',
    moduleName: string
  ): string | undefined {
    const candidates = this.getPluginCodeCandidates(area);
    const visited = new Set<string>();

    for (const candidateRoot of candidates) {
      const root = path.resolve(candidateRoot);
      if (visited.has(root)) continue;
      visited.add(root);

      if (!fs.existsSync(root)) continue;

      const found = this.resolvePluginCodeEntryInRoot(root, moduleName);
      if (found) return found;
    }

    return undefined;
  }

  private resolvePluginCodeEntryMultiRoot(
    area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat',
    moduleName: string,
    preferredPackRoot?: string
  ): { modulePath: string; key: string } | undefined {
    const preferred = preferredPackRoot && path.isAbsolute(preferredPackRoot)
      ? preferredPackRoot
      : preferredPackRoot
        ? path.resolve(process.cwd(), preferredPackRoot)
        : undefined;

    const cacheKey = preferred ? `${moduleName}@@${preferred}` : moduleName;

    // Prefer-same-root binding: if the manifest root has the module, use it even if other roots have it.
    if (preferred) {
      const preferredRoot = path.join(preferred, area);
      if (fs.existsSync(preferredRoot)) {
        const preferredEntry = this.resolvePluginCodeEntryInRoot(preferredRoot, moduleName);
        if (preferredEntry) {
          return { modulePath: preferredEntry, key: cacheKey };
        }
      }
    }

    const rootsHighToLow = this.getPackRootsLowToHigh(area, 'code').slice().reverse();
    const hits: Array<{ root: string; kind: PluginRegistrySourceKind; precedence: number; modulePath: string }> = [];

    for (const root of rootsHighToLow) {
      const codeRoot = path.join(root.root, area);
      if (!fs.existsSync(codeRoot)) continue;

      const found = this.resolvePluginCodeEntryInRoot(codeRoot, moduleName);
      if (found) {
        hits.push({ root: root.root, kind: root.kind, precedence: root.precedence, modulePath: found });
      }
    }

    const winner = hits[0];
    if (!winner) return undefined;

    if (this.lookup?.warnOnOverride && hits.length > 1) {
      try {
        console.warn('plugin_registry.code_override', {
          area,
          moduleName,
          winner: { kind: winner.kind, root: winner.root, precedence: winner.precedence, modulePath: winner.modulePath },
          overridden: hits.slice(1).map(h => ({ kind: h.kind, root: h.root, precedence: h.precedence, modulePath: h.modulePath }))
        });
      } catch {}
    }

    return { modulePath: winner.modulePath, key: cacheKey };
  }

  private async importPluginCodeModule(modulePath: string): Promise<any> {
    return import(pathToFileURL(modulePath).href);
  }

  private getDefaultOrFirstExport(imported: Record<string, any>): any {
    return imported.default ?? imported[Object.keys(imported)[0]];
  }

  private assertSafePluginModuleName(
    area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat',
    moduleName: string
  ): void {
    // Module names come from manifests; harden against path traversal and invalid paths.
    // Allow only simple names like "example-compat" or "example_store".
    if (!/^[a-zA-Z0-9._-]+$/.test(moduleName)) {
      throw new ManifestError(`Invalid ${area} module name '${moduleName}'`);
    }
    if (moduleName === '.' || moduleName === '..' || moduleName.includes('..')) {
      throw new ManifestError(`Invalid ${area} module name '${moduleName}'`);
    }
  }

  private async ensureCompatModuleLoaded(moduleName: string, options: { preferredPackRoot?: string } = {}): Promise<string> {
    this.compatModulesLoaded = true;
    this.assertSafePluginModuleName('compat', moduleName);

    const resolved = this.mode === 'multi-root'
      ? this.resolvePluginCodeEntryMultiRoot('compat', moduleName, options.preferredPackRoot)
      : (() => {
          const modulePath = this.resolvePluginCodeEntry('compat', moduleName);
          return modulePath ? { modulePath, key: moduleName } : undefined;
        })();

    if (!resolved) {
      throw new ManifestError(`No compat module found for '${moduleName}'`);
    }

    if (this.compatModules.has(resolved.key)) {
      return resolved.key;
    }

    try {
      const imported = await this.importPluginCodeModule(resolved.modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.compatModules.set(resolved.key, () => new (CompatClass as any)());
      return resolved.key;
    } catch (error: any) {
      console.warn(`Failed to load compat module ${moduleName}: ${error.message}`);
      throw new ManifestError(`No compat module found for '${moduleName}'`);
    }
  }

  private async ensureEmbeddingCompatLoaded(kind: string, options: { preferredPackRoot?: string } = {}): Promise<string> {
    this.embeddingCompatsLoaded = true;
    this.assertSafePluginModuleName('embedding-compat', kind);

    const resolved = this.mode === 'multi-root'
      ? this.resolvePluginCodeEntryMultiRoot('embedding-compat', kind, options.preferredPackRoot)
      : (() => {
          const modulePath = this.resolvePluginCodeEntry('embedding-compat', kind);
          return modulePath ? { modulePath, key: kind } : undefined;
        })();

    if (!resolved) {
      throw new ManifestError(`No embedding compat module found for '${kind}'`);
    }

    if (this.embeddingCompats.has(resolved.key)) {
      return resolved.key;
    }

    try {
      const imported = await this.importPluginCodeModule(resolved.modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.embeddingCompats.set(resolved.key, () => new (CompatClass as any)());
      return resolved.key;
    } catch (error: any) {
      console.warn(`Failed to load embedding compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No embedding compat module found for '${kind}'`);
    }
  }

  private async ensureVectorStoreCompatLoaded(kind: string, options: { preferredPackRoot?: string } = {}): Promise<string> {
    this.vectorStoreCompatsLoaded = true;
    this.assertSafePluginModuleName('vector-compat', kind);

    const resolved = this.mode === 'multi-root'
      ? this.resolvePluginCodeEntryMultiRoot('vector-compat', kind, options.preferredPackRoot)
      : (() => {
          const modulePath = this.resolvePluginCodeEntry('vector-compat', kind);
          return modulePath ? { modulePath, key: kind } : undefined;
        })();

    if (!resolved) {
      throw new ManifestError(`No vector store compat module found for '${kind}'`);
    }

    if (this.vectorStoreCompats.has(resolved.key)) {
      return resolved.key;
    }

    try {
      const imported = await this.importPluginCodeModule(resolved.modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        console.warn(`Failed to load vector store compat module ${kind}: module did not export a constructor`);
        throw new ManifestError(`No vector store compat module found for '${kind}'`);
      }
      this.vectorStoreCompats.set(resolved.key, () => new (CompatClass as any)());
      return resolved.key;
    } catch (error: any) {
      // If we already threw a ManifestError for non-constructors above, preserve that without duplicating warnings.
      if (error instanceof ManifestError) {
        throw error;
      }
      console.warn(`Failed to load vector store compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No vector store compat module found for '${kind}'`);
    }
  }

  private async ensureRealtimeCompatLoaded(kind: string, options: { preferredPackRoot?: string } = {}): Promise<string> {
    this.realtimeCompatsLoaded = true;
    this.assertSafePluginModuleName('realtime-compat', kind);

    const resolved = this.mode === 'multi-root'
      ? this.resolvePluginCodeEntryMultiRoot('realtime-compat', kind, options.preferredPackRoot)
      : (() => {
          const modulePath = this.resolvePluginCodeEntry('realtime-compat', kind);
          return modulePath ? { modulePath, key: kind } : undefined;
        })();

    if (!resolved) {
      throw new ManifestError(`No realtime compat module found for '${kind}'`);
    }

    if (this.realtimeCompats.has(resolved.key)) {
      return resolved.key;
    }

    try {
      const imported = await this.importPluginCodeModule(resolved.modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.realtimeCompats.set(resolved.key, () => new (CompatClass as any)());
      return resolved.key;
    } catch (error: any) {
      console.warn(`Failed to load realtime compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No realtime compat module found for '${kind}'`);
    }
  }

  private async ensureObservabilityCompatLoaded(kind: string, options: { preferredPackRoot?: string } = {}): Promise<string> {
    this.observabilityCompatsLoaded = true;
    this.assertSafePluginModuleName('observability-compat', kind);

    const resolved = this.mode === 'multi-root'
      ? this.resolvePluginCodeEntryMultiRoot('observability-compat', kind, options.preferredPackRoot)
      : (() => {
          const modulePath = this.resolvePluginCodeEntry('observability-compat', kind);
          return modulePath ? { modulePath, key: kind } : undefined;
        })();

    if (!resolved) {
      throw new ManifestError(`No observability compat module found for '${kind}'`);
    }

    if (this.observabilityCompats.has(resolved.key)) {
      return resolved.key;
    }

    try {
      const imported = await this.importPluginCodeModule(resolved.modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.observabilityCompats.set(resolved.key, () => new (CompatClass as any)());
      return resolved.key;
    } catch (error: any) {
      console.warn(`Failed to load observability compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No observability compat module found for '${kind}'`);
    }
  }

  private async loadProviders(): Promise<void> {
    return this.loadProvidersInternal();
  }

  private async loadProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.providersLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('providers/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const manifest = loadJsonFile(path.join(this.rootPath, file)) as ProviderManifest;
          this.providers.set(manifest.id, manifest);
          continue;
        }

        try {
          const manifest = loadJsonFile(path.join(this.rootPath, file)) as ProviderManifest;
          this.providers.set(manifest.id, manifest);
        } catch (error: any) {
          console.warn(`Skipping provider manifest ${file}: ${error.message}`);
        }
      }

      this.providersLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('providers', 'manifests');
    for (const root of roots) {
      const files = glob.sync('providers/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const manifest = loadJsonFile(fullPath) as ProviderManifest;
          const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid provider manifest '${fullPath}': missing id`);
          }

          const prev = this.getManifestSource('providers', id);
          if (prev) this.warnOnOverride('providers', id, prev, source);
          this.providers.set(id, manifest);
          this.setManifestSource('providers', id, source);
          continue;
        }

        try {
          const manifest = loadJsonFile(fullPath) as ProviderManifest;
          const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
          if (!id) {
            console.warn(`Skipping provider manifest ${file}: missing id`);
            continue;
          }

          const prev = this.getManifestSource('providers', id);
          if (prev) this.warnOnOverride('providers', id, prev, source);
          this.providers.set(id, manifest);
          this.setManifestSource('providers', id, source);
        } catch (error: any) {
          console.warn(`Skipping provider manifest ${file}: ${error.message}`);
        }
      }
    }

    this.providersLoaded = true;
  }

  private async loadRealtimeProviders(): Promise<void> {
    return this.loadRealtimeProvidersInternal();
  }

  private async loadRealtimeProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.realtimeProvidersLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('realtime-providers/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const manifest = loadJsonFile(path.join(this.rootPath, file)) as RealtimeProviderManifest;
          this.realtimeProviders.set(manifest.id, manifest);
          continue;
        }

        try {
          const manifest = loadJsonFile(path.join(this.rootPath, file)) as RealtimeProviderManifest;
          this.realtimeProviders.set(manifest.id, manifest);
        } catch (error: any) {
          console.warn(`Skipping realtime provider manifest ${file}: ${error.message}`);
        }
      }

      this.realtimeProvidersLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('realtime-providers', 'manifests');
    for (const root of roots) {
      const files = glob.sync('realtime-providers/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const manifest = loadJsonFile(fullPath) as RealtimeProviderManifest;
          const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid realtime provider manifest '${fullPath}': missing id`);
          }

          const prev = this.getManifestSource('realtime-providers', id);
          if (prev) this.warnOnOverride('realtime-providers', id, prev, source);
          this.realtimeProviders.set(id, manifest);
          this.setManifestSource('realtime-providers', id, source);
          continue;
        }

        try {
          const manifest = loadJsonFile(fullPath) as RealtimeProviderManifest;
          const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
          if (!id) {
            console.warn(`Skipping realtime provider manifest ${file}: missing id`);
            continue;
          }

          const prev = this.getManifestSource('realtime-providers', id);
          if (prev) this.warnOnOverride('realtime-providers', id, prev, source);
          this.realtimeProviders.set(id, manifest);
          this.setManifestSource('realtime-providers', id, source);
        } catch (error: any) {
          console.warn(`Skipping realtime provider manifest ${file}: ${error.message}`);
        }
      }
    }

    this.realtimeProvidersLoaded = true;
  }

  private async loadTools(): Promise<void> {
    return this.loadToolsInternal();
  }

  private async loadToolsInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.toolsLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('tools/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const tool = loadJsonFile(path.join(this.rootPath, file)) as UnifiedTool;
          this.tools.set(tool.name, tool);
          continue;
        }

        try {
          const tool = loadJsonFile(path.join(this.rootPath, file)) as UnifiedTool;
          this.tools.set(tool.name, tool);
        } catch (error: any) {
          console.warn(`Skipping tool manifest ${file}: ${error.message}`);
        }
      }

      this.toolsLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('tools', 'manifests');
    for (const root of roots) {
      const files = glob.sync('tools/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const tool = loadJsonFile(fullPath) as UnifiedTool;
          const name = typeof (tool as any)?.name === 'string' ? String((tool as any).name) : '';
          if (!name) {
            throw new ManifestError(`Invalid tool manifest '${fullPath}': missing name`);
          }

          const prev = this.getManifestSource('tools', name);
          if (prev) this.warnOnOverride('tools', name, prev, source);
          this.tools.set(name, tool);
          this.setManifestSource('tools', name, source);
          continue;
        }

        try {
          const tool = loadJsonFile(fullPath) as UnifiedTool;
          const name = typeof (tool as any)?.name === 'string' ? String((tool as any).name) : '';
          if (!name) {
            console.warn(`Skipping tool manifest ${file}: missing name`);
            continue;
          }

          const prev = this.getManifestSource('tools', name);
          if (prev) this.warnOnOverride('tools', name, prev, source);
          this.tools.set(name, tool);
          this.setManifestSource('tools', name, source);
        } catch (error: any) {
          console.warn(`Skipping tool manifest ${file}: ${error.message}`);
        }
      }
    }

    this.toolsLoaded = true;
  }

  private async loadMCPServers(): Promise<void> {
    return this.loadMCPServersInternal();
  }

  private async loadMCPServersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.mcpServersLoaded) return;

    const { parseMCPManifest } = await import('../../modules/mcp/index.js');

    if (this.mode === 'legacy') {
      const files = glob.sync('mcp/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const manifestPath = path.join(this.rootPath, file);
          const manifest = loadJsonFile(manifestPath);
          const servers = parseMCPManifest(manifest, file);
          for (const server of servers) {
            this.mcpServers.set(server.id, server);
          }
          continue;
        }

        try {
          const manifestPath = path.join(this.rootPath, file);
          const manifest = loadJsonFile(manifestPath);
          const servers = parseMCPManifest(manifest, file);
          for (const server of servers) {
            this.mcpServers.set(server.id, server);
          }
        } catch (error: any) {
          console.warn(`Skipping MCP server manifest ${file}: ${error.message}`);
        }
      }

      this.mcpServersLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('mcp', 'manifests');
    for (const root of roots) {
      const files = glob.sync('mcp/*.json', { cwd: root.root });
      for (const file of files) {
        const manifestPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: manifestPath, precedence: root.precedence };

        if (options.strict) {
          const manifest = loadJsonFile(manifestPath);
          const servers = parseMCPManifest(manifest, file);
          for (const server of servers) {
            const id = server.id;
            if (!id) {
              throw new ManifestError(`Invalid MCP server manifest '${manifestPath}': missing id`);
            }
            const prev = this.getManifestSource('mcp', id);
            if (prev) this.warnOnOverride('mcp', id, prev, source);
            this.mcpServers.set(id, server);
            this.setManifestSource('mcp', id, source);
          }
          continue;
        }

        try {
          const manifest = loadJsonFile(manifestPath);
          const servers = parseMCPManifest(manifest, file);
          for (const server of servers) {
            const id = server.id;
            if (!id) {
              console.warn(`Skipping MCP server manifest ${file}: missing id`);
              continue;
            }
            const prev = this.getManifestSource('mcp', id);
            if (prev) this.warnOnOverride('mcp', id, prev, source);
            this.mcpServers.set(id, server);
            this.setManifestSource('mcp', id, source);
          }
        } catch (error: any) {
          console.warn(`Skipping MCP server manifest ${file}: ${error.message}`);
        }
      }
    }

    this.mcpServersLoaded = true;
  }

  private async loadVectorStores(): Promise<void> {
    return this.loadVectorStoresInternal();
  }

  private async loadVectorStoresInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.vectorStoresLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('vector/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const store = loadJsonFile(path.join(this.rootPath, file)) as VectorStoreConfig;
          this.vectorStores.set(store.id, store);
          continue;
        }

        try {
          const store = loadJsonFile(path.join(this.rootPath, file)) as VectorStoreConfig;
          this.vectorStores.set(store.id, store);
        } catch (error: any) {
          console.warn(`Skipping vector store manifest ${file}: ${error.message}`);
        }
      }

      this.vectorStoresLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('vector', 'manifests');
    for (const root of roots) {
      const files = glob.sync('vector/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const store = loadJsonFile(fullPath) as VectorStoreConfig;
          const id = typeof (store as any)?.id === 'string' ? String((store as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid vector store manifest '${fullPath}': missing id`);
          }

          const prev = this.getManifestSource('vector', id);
          if (prev) this.warnOnOverride('vector', id, prev, source);
          this.vectorStores.set(id, store);
          this.setManifestSource('vector', id, source);
          continue;
        }

        try {
          const store = loadJsonFile(fullPath) as VectorStoreConfig;
          const id = typeof (store as any)?.id === 'string' ? String((store as any).id) : '';
          if (!id) {
            console.warn(`Skipping vector store manifest ${file}: missing id`);
            continue;
          }

          const prev = this.getManifestSource('vector', id);
          if (prev) this.warnOnOverride('vector', id, prev, source);
          this.vectorStores.set(id, store);
          this.setManifestSource('vector', id, source);
        } catch (error: any) {
          console.warn(`Skipping vector store manifest ${file}: ${error.message}`);
        }
      }
    }

    this.vectorStoresLoaded = true;
  }

  private async loadProcessRoutes(): Promise<void> {
    return this.loadProcessRoutesInternal();
  }

  private async loadProcessRoutesInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.processRoutesLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('processes/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const route = loadJsonFile(path.join(this.rootPath, file)) as ProcessRouteManifest;
          this.processRoutes.push(route);
          continue;
        }

        try {
          const route = loadJsonFile(path.join(this.rootPath, file)) as ProcessRouteManifest;
          this.processRoutes.push(route);
        } catch (error: any) {
          console.warn(`Skipping process route manifest ${file}: ${error.message}`);
        }
      }

      this.processRoutesLoaded = true;
      return;
    }

    const routesById = new Map<string, ProcessRouteManifest>();
    const roots = this.getPackRootsLowToHigh('processes', 'manifests');
    for (const root of roots) {
      const files = glob.sync('processes/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const route = loadJsonFile(fullPath) as ProcessRouteManifest;
          const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid process route manifest '${fullPath}': missing id`);
          }

          const prev = this.getManifestSource('processes', id);
          if (prev) this.warnOnOverride('processes', id, prev, source);
          routesById.set(id, route);
          this.setManifestSource('processes', id, source);
          continue;
        }

        try {
          const route = loadJsonFile(fullPath) as ProcessRouteManifest;
          const id = typeof (route as any)?.id === 'string' ? String((route as any).id) : '';
          if (!id) {
            console.warn(`Skipping process route manifest ${file}: missing id`);
            continue;
          }

          const prev = this.getManifestSource('processes', id);
          if (prev) this.warnOnOverride('processes', id, prev, source);
          routesById.set(id, route);
          this.setManifestSource('processes', id, source);
        } catch (error: any) {
          console.warn(`Skipping process route manifest ${file}: ${error.message}`);
        }
      }
    }

    this.processRoutes = Array.from(routesById.values());

    this.processRoutesLoaded = true;
  }

  private async loadEmbeddingProviders(): Promise<void> {
    return this.loadEmbeddingProvidersInternal();
  }

  private async loadEmbeddingProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.embeddingProvidersLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('embeddings/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const config = loadJsonFile(path.join(this.rootPath, file)) as EmbeddingProviderConfig;
          this.embeddingProviders.set(config.id, config);
          continue;
        }

        try {
          const config = loadJsonFile(path.join(this.rootPath, file)) as EmbeddingProviderConfig;
          this.embeddingProviders.set(config.id, config);
        } catch (error: any) {
          console.warn(`Skipping embedding provider config ${file}: ${error.message}`);
        }
      }

      this.embeddingProvidersLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('embeddings', 'manifests');
    for (const root of roots) {
      const files = glob.sync('embeddings/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const config = loadJsonFile(fullPath) as EmbeddingProviderConfig;
          const id = typeof (config as any)?.id === 'string' ? String((config as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid embedding provider config '${fullPath}': missing id`);
          }

          const prev = this.getManifestSource('embeddings', id);
          if (prev) this.warnOnOverride('embeddings', id, prev, source);
          this.embeddingProviders.set(id, config);
          this.setManifestSource('embeddings', id, source);
          continue;
        }

        try {
          const config = loadJsonFile(fullPath) as EmbeddingProviderConfig;
          const id = typeof (config as any)?.id === 'string' ? String((config as any).id) : '';
          if (!id) {
            console.warn(`Skipping embedding provider config ${file}: missing id`);
            continue;
          }

          const prev = this.getManifestSource('embeddings', id);
          if (prev) this.warnOnOverride('embeddings', id, prev, source);
          this.embeddingProviders.set(id, config);
          this.setManifestSource('embeddings', id, source);
        } catch (error: any) {
          console.warn(`Skipping embedding provider config ${file}: ${error.message}`);
        }
      }
    }

    this.embeddingProvidersLoaded = true;
  }

  private async loadObservabilityProviders(): Promise<void> {
    return this.loadObservabilityProvidersInternal();
  }

  private async loadObservabilityProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.observabilityProvidersLoaded) return;

    if (this.mode === 'legacy') {
      const files = glob.sync('observability-providers/*.json', { cwd: this.rootPath });
      for (const file of files) {
        if (options.strict) {
          const manifest = loadJsonFile(path.join(this.rootPath, file)) as ObservabilityProviderManifest;
          this.observabilityProviders.set(manifest.id, manifest);
          continue;
        }

        try {
          const manifest = loadJsonFile(path.join(this.rootPath, file)) as ObservabilityProviderManifest;
          this.observabilityProviders.set(manifest.id, manifest);
        } catch (error: any) {
          console.warn(`Skipping observability provider manifest ${file}: ${error.message}`);
        }
      }

      this.observabilityProvidersLoaded = true;
      return;
    }

    const roots = this.getPackRootsLowToHigh('observability-providers', 'manifests');
    for (const root of roots) {
      const files = glob.sync('observability-providers/*.json', { cwd: root.root });
      for (const file of files) {
        const fullPath = path.join(root.root, file);
        const source: ManifestSourceMeta = { kind: root.kind, root: root.root, filePath: fullPath, precedence: root.precedence };

        if (options.strict) {
          const manifest = loadJsonFile(fullPath) as ObservabilityProviderManifest;
          const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
          if (!id) {
            throw new ManifestError(`Invalid observability provider manifest '${fullPath}': missing id`);
          }

          const prev = this.getManifestSource('observability-providers', id);
          if (prev) this.warnOnOverride('observability-providers', id, prev, source);
          this.observabilityProviders.set(id, manifest);
          this.setManifestSource('observability-providers', id, source);
          continue;
        }

        try {
          const manifest = loadJsonFile(fullPath) as ObservabilityProviderManifest;
          const id = typeof (manifest as any)?.id === 'string' ? String((manifest as any).id) : '';
          if (!id) {
            console.warn(`Skipping observability provider manifest ${file}: missing id`);
            continue;
          }

          const prev = this.getManifestSource('observability-providers', id);
          if (prev) this.warnOnOverride('observability-providers', id, prev, source);
          this.observabilityProviders.set(id, manifest);
          this.setManifestSource('observability-providers', id, source);
        } catch (error: any) {
          console.warn(`Skipping observability provider manifest ${file}: ${error.message}`);
        }
      }
    }

    this.observabilityProvidersLoaded = true;
  }

  /**
   * Opt-in: validate and preload all manifests + referenced plugin code.
   * Useful for fail-fast startup checks in long-lived processes.
   *
   * Default usage remains lazy; callers must invoke this explicitly.
   */
  async validateAll(): Promise<void> {
    await this.loadProvidersInternal({ strict: true });
    await this.loadRealtimeProvidersInternal({ strict: true });
    await this.loadToolsInternal({ strict: true });
    await this.loadMCPServersInternal({ strict: true });
    await this.loadVectorStoresInternal({ strict: true });
    await this.loadProcessRoutesInternal({ strict: true });
    await this.loadEmbeddingProvidersInternal({ strict: true });
    await this.loadObservabilityProvidersInternal({ strict: true });

    // Validate that referenced plugin code modules exist and can be imported.
    for (const provider of this.providers.values()) {
      await this.ensureCompatModuleLoaded(provider.compat);
    }

    for (const provider of this.realtimeProviders.values()) {
      await this.ensureRealtimeCompatLoaded(provider.compat);
    }

    for (const store of this.vectorStores.values()) {
      await this.ensureVectorStoreCompatLoaded(store.kind);
    }

    for (const embedding of this.embeddingProviders.values()) {
      await this.ensureEmbeddingCompatLoaded(embedding.kind);
    }

    for (const observability of this.observabilityProviders.values()) {
      await this.ensureObservabilityCompatLoaded(observability.compat);
    }
  }

  async getProvider(id: string): Promise<ProviderManifest> {
    await this.loadProviders();
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown provider '${id}'`);
    }
    return provider;
  }

  async getCompatModuleForProvider(providerId: string): Promise<ICompatModule> {
    await this.loadProviders();
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ManifestError(`Unknown provider '${providerId}'`);
    }

    const preferredPackRoot = this.getManifestSource('providers', providerId)?.root;
    const key = await this.ensureCompatModuleLoaded(provider.compat, { preferredPackRoot });
    return this.compatModules.get(key)!();
  }

  async getRealtimeProvider(id: string): Promise<RealtimeProviderManifest> {
    await this.loadRealtimeProviders();
    const provider = this.realtimeProviders.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown realtime provider '${id}'`);
    }
    return provider;
  }

  async getRealtimeCompatForProvider(providerId: string): Promise<IRealtimeCompat> {
    await this.loadRealtimeProviders();
    const provider = this.realtimeProviders.get(providerId);
    if (!provider) {
      throw new ManifestError(`Unknown realtime provider '${providerId}'`);
    }

    const preferredPackRoot = this.getManifestSource('realtime-providers', providerId)?.root;
    const key = await this.ensureRealtimeCompatLoaded(provider.compat, { preferredPackRoot });
    return this.realtimeCompats.get(key)!();
  }

  async getTool(name: string): Promise<UnifiedTool> {
    await this.loadTools();
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ManifestError(`Unknown tool '${name}'`);
    }
    return tool;
  }

  async getTools(names: string[]): Promise<UnifiedTool[]> {
    await this.loadTools();
    return names.map(name => {
      const tool = this.tools.get(name);
      if (!tool) {
        throw new ManifestError(`Unknown tool '${name}'`);
      }
      return tool;
    });
  }

  async getMCPServer(id: string): Promise<MCPServerConfig> {
    await this.loadMCPServers();
    const server = this.mcpServers.get(id);
    if (!server) {
      throw new ManifestError(`Unknown MCP server '${id}'`);
    }
    return server;
  }

  async getMCPServers(serverIds?: string[]): Promise<MCPServerConfig[]> {
    // Only load if specific servers requested
    if (!serverIds || serverIds.length === 0) {
      return [];
    }

    await this.loadMCPServers();

    return serverIds.map(id => {
      const server = this.mcpServers.get(id);
      if (!server) {
        throw new ManifestError(`Unknown MCP server '${id}'`);
      }
      return server;
    });
  }

  async getVectorStore(id: string): Promise<VectorStoreConfig> {
    await this.loadVectorStores();
    const store = this.vectorStores.get(id);
    if (!store) {
      throw new ManifestError(`Unknown vector store '${id}'`);
    }
    return store;
  }

  async getVectorStoreCompatForStore(storeId: string): Promise<IVectorStoreCompat> {
    await this.loadVectorStores();
    const store = this.vectorStores.get(storeId);
    if (!store) {
      throw new ManifestError(`Unknown vector store '${storeId}'`);
    }

    const preferredPackRoot = this.getManifestSource('vector', storeId)?.root;
    const key = await this.ensureVectorStoreCompatLoaded(store.kind, { preferredPackRoot });
    return this.vectorStoreCompats.get(key)!();
  }

  async getProcessRoutes(): Promise<ProcessRouteManifest[]> {
    await this.loadProcessRoutes();
    return this.processRoutes;
  }

  async getCompatModule(compat: string): Promise<ICompatModule> {
    const key = await this.ensureCompatModuleLoaded(compat);
    return this.compatModules.get(key)!();
  }

  async getEmbeddingProvider(id: string): Promise<EmbeddingProviderConfig> {
    await this.loadEmbeddingProviders();
    const config = this.embeddingProviders.get(id);
    if (!config) {
      throw new ManifestError(`Unknown embedding provider '${id}'`);
    }
    return config;
  }

  async getEmbeddingCompatForProvider(providerId: string): Promise<IEmbeddingCompat> {
    await this.loadEmbeddingProviders();
    const config = this.embeddingProviders.get(providerId);
    if (!config) {
      throw new ManifestError(`Unknown embedding provider '${providerId}'`);
    }

    const preferredPackRoot = this.getManifestSource('embeddings', providerId)?.root;
    const key = await this.ensureEmbeddingCompatLoaded(config.kind, { preferredPackRoot });
    return this.embeddingCompats.get(key)!();
  }

  async getEmbeddingCompat(kind: string): Promise<IEmbeddingCompat> {
    const key = await this.ensureEmbeddingCompatLoaded(kind);
    return this.embeddingCompats.get(key)!();
  }

  async getVectorStoreCompat(kind: string): Promise<IVectorStoreCompat> {
    const key = await this.ensureVectorStoreCompatLoaded(kind);
    return this.vectorStoreCompats.get(key)!();
  }

  async getRealtimeCompat(kind: string): Promise<IRealtimeCompat> {
    const key = await this.ensureRealtimeCompatLoaded(kind);
    return this.realtimeCompats.get(key)!();
  }

  async getObservabilityProvider(id: string): Promise<ObservabilityProviderManifest> {
    await this.loadObservabilityProviders();
    const manifest = this.observabilityProviders.get(id);
    if (!manifest) {
      throw new ManifestError(`Unknown observability provider '${id}'`);
    }
    return manifest;
  }

  async getObservabilityCompatForProvider(providerId: string): Promise<IObservabilityCompat> {
    await this.loadObservabilityProviders();
    const manifest = this.observabilityProviders.get(providerId);
    if (!manifest) {
      throw new ManifestError(`Unknown observability provider '${providerId}'`);
    }

    const preferredPackRoot = this.getManifestSource('observability-providers', providerId)?.root;
    const key = await this.ensureObservabilityCompatLoaded(manifest.compat, { preferredPackRoot });
    return this.observabilityCompats.get(key)!();
  }

  async getObservabilityCompat(kind: string): Promise<IObservabilityCompat> {
    const key = await this.ensureObservabilityCompatLoaded(kind);
    return this.observabilityCompats.get(key)!();
  }
}
