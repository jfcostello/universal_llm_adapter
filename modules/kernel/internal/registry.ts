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
  IVectorStoreCompat
} from './types.js';
import type { IRealtimeCompat } from './realtime-types.js';
import { ManifestError } from './errors.js';

const distRoot = PACKAGE_ROOT;

export class PluginRegistry {
  private rootPath: string;
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

  constructor(rootPath: string) {
    this.rootPath = path.isAbsolute(rootPath)
      ? rootPath
      : path.resolve(process.cwd(), rootPath);

    if (!fs.existsSync(this.rootPath)) {
      throw new ManifestError(`Plugin directory '${this.rootPath}' does not exist`);
    }
  }

  async loadAll(): Promise<void> {
    // Deprecated: kept for backward compatibility but does nothing
    // All loading is now lazy and on-demand
  }

  private getPluginCodeCandidates(area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat'): string[] {
    return [
      path.resolve(distRoot, 'plugins', area),
      path.join(this.rootPath, area),
      path.resolve(process.cwd(), 'plugins', area),
    ];
  }

  private resolvePluginCodeEntry(
    area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat',
    moduleName: string
  ): string | undefined {
    const candidates = this.getPluginCodeCandidates(area);
    const visited = new Set<string>();

    for (const candidateRoot of candidates) {
      const root = path.resolve(candidateRoot);
      if (visited.has(root)) continue;
      visited.add(root);

      if (!fs.existsSync(root)) continue;

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
    }

    return undefined;
  }

  private async importPluginCodeModule(modulePath: string): Promise<any> {
    return import(pathToFileURL(modulePath).href);
  }

  private getDefaultOrFirstExport(imported: Record<string, any>): any {
    return imported.default ?? imported[Object.keys(imported)[0]];
  }

  private assertSafePluginModuleName(
    area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat',
    moduleName: string
  ): void {
    // Module names come from manifests; harden against path traversal and invalid paths.
    // Allow only simple names like "example-compat" or "example_store".
    if (!/^[a-zA-Z0-9._-]+$/.test(moduleName)) {
      throw new ManifestError(`Invalid ${area} module name '${moduleName}'`);
    }
  }

  private async ensureCompatModuleLoaded(moduleName: string): Promise<void> {
    if (this.compatModules.has(moduleName)) return;

    this.compatModulesLoaded = true;

    this.assertSafePluginModuleName('compat', moduleName);

    const modulePath = this.resolvePluginCodeEntry('compat', moduleName);
    if (!modulePath) {
      throw new ManifestError(`No compat module found for '${moduleName}'`);
    }

    try {
      const imported = await this.importPluginCodeModule(modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.compatModules.set(moduleName, () => new (CompatClass as any)());
    } catch (error: any) {
      console.warn(`Failed to load compat module ${moduleName}: ${error.message}`);
      throw new ManifestError(`No compat module found for '${moduleName}'`);
    }
  }

  private async ensureEmbeddingCompatLoaded(kind: string): Promise<void> {
    if (this.embeddingCompats.has(kind)) return;

    this.embeddingCompatsLoaded = true;

    this.assertSafePluginModuleName('embedding-compat', kind);

    const modulePath = this.resolvePluginCodeEntry('embedding-compat', kind);
    if (!modulePath) {
      throw new ManifestError(`No embedding compat module found for '${kind}'`);
    }

    try {
      const imported = await this.importPluginCodeModule(modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.embeddingCompats.set(kind, () => new (CompatClass as any)());
    } catch (error: any) {
      console.warn(`Failed to load embedding compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No embedding compat module found for '${kind}'`);
    }
  }

  private async ensureVectorStoreCompatLoaded(kind: string): Promise<void> {
    if (this.vectorStoreCompats.has(kind)) return;

    this.vectorStoreCompatsLoaded = true;

    this.assertSafePluginModuleName('vector-compat', kind);

    const modulePath = this.resolvePluginCodeEntry('vector-compat', kind);
    if (!modulePath) {
      throw new ManifestError(`No vector store compat module found for '${kind}'`);
    }

    try {
      const imported = await this.importPluginCodeModule(modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        console.warn(`Failed to load vector store compat module ${kind}: module did not export a constructor`);
        throw new ManifestError(`No vector store compat module found for '${kind}'`);
      }
      this.vectorStoreCompats.set(kind, () => new (CompatClass as any)());
    } catch (error: any) {
      // If we already threw a ManifestError for non-constructors above, preserve that without duplicating warnings.
      if (error instanceof ManifestError) {
        throw error;
      }
      console.warn(`Failed to load vector store compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No vector store compat module found for '${kind}'`);
    }
  }

  private async ensureRealtimeCompatLoaded(kind: string): Promise<void> {
    if (this.realtimeCompats.has(kind)) return;

    this.realtimeCompatsLoaded = true;

    this.assertSafePluginModuleName('realtime-compat', kind);

    const modulePath = this.resolvePluginCodeEntry('realtime-compat', kind);
    if (!modulePath) {
      throw new ManifestError(`No realtime compat module found for '${kind}'`);
    }

    try {
      const imported = await this.importPluginCodeModule(modulePath);
      const CompatClass = this.getDefaultOrFirstExport(imported);
      if (typeof CompatClass !== 'function') {
        throw new Error('module did not export a constructor');
      }
      this.realtimeCompats.set(kind, () => new (CompatClass as any)());
    } catch (error: any) {
      console.warn(`Failed to load realtime compat module ${kind}: ${error.message}`);
      throw new ManifestError(`No realtime compat module found for '${kind}'`);
    }
  }

  private async loadProviders(): Promise<void> {
    return this.loadProvidersInternal();
  }

  private async loadProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.providersLoaded) return;

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
  }

  private async loadRealtimeProviders(): Promise<void> {
    return this.loadRealtimeProvidersInternal();
  }

  private async loadRealtimeProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.realtimeProvidersLoaded) return;

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
  }

  private async loadTools(): Promise<void> {
    return this.loadToolsInternal();
  }

  private async loadToolsInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.toolsLoaded) return;

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
  }

  private async loadMCPServers(): Promise<void> {
    return this.loadMCPServersInternal();
  }

  private async loadMCPServersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.mcpServersLoaded) return;

    const { parseMCPManifest } = await import('../../mcp/index.js');
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
  }

  private async loadVectorStores(): Promise<void> {
    return this.loadVectorStoresInternal();
  }

  private async loadVectorStoresInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.vectorStoresLoaded) return;

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
  }

  private async loadProcessRoutes(): Promise<void> {
    return this.loadProcessRoutesInternal();
  }

  private async loadProcessRoutesInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.processRoutesLoaded) return;

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
  }

  private async loadEmbeddingProviders(): Promise<void> {
    return this.loadEmbeddingProvidersInternal();
  }

  private async loadEmbeddingProvidersInternal(options: { strict?: boolean } = {}): Promise<void> {
    if (this.embeddingProvidersLoaded) return;

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
  }

  async getProvider(id: string): Promise<ProviderManifest> {
    await this.loadProviders();
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown provider '${id}'`);
    }
    return provider;
  }

  async getRealtimeProvider(id: string): Promise<RealtimeProviderManifest> {
    await this.loadRealtimeProviders();
    const provider = this.realtimeProviders.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown realtime provider '${id}'`);
    }
    return provider;
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

  async getProcessRoutes(): Promise<ProcessRouteManifest[]> {
    await this.loadProcessRoutes();
    return this.processRoutes;
  }

  async getCompatModule(compat: string): Promise<ICompatModule> {
    await this.ensureCompatModuleLoaded(compat);
    return this.compatModules.get(compat)!();
  }

  async getEmbeddingProvider(id: string): Promise<EmbeddingProviderConfig> {
    await this.loadEmbeddingProviders();
    const config = this.embeddingProviders.get(id);
    if (!config) {
      throw new ManifestError(`Unknown embedding provider '${id}'`);
    }
    return config;
  }

  async getEmbeddingCompat(kind: string): Promise<IEmbeddingCompat> {
    await this.ensureEmbeddingCompatLoaded(kind);
    return this.embeddingCompats.get(kind)!();
  }

  async getVectorStoreCompat(kind: string): Promise<IVectorStoreCompat> {
    await this.ensureVectorStoreCompatLoaded(kind);
    return this.vectorStoreCompats.get(kind)!();
  }

  async getRealtimeCompat(kind: string): Promise<IRealtimeCompat> {
    await this.ensureRealtimeCompatLoaded(kind);
    return this.realtimeCompats.get(kind)!();
  }
}
