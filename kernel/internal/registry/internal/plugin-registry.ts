import * as fs from 'fs';
import * as path from 'path';

import type {
  EmbeddingProviderConfig,
  ICompatModule,
  IEmbeddingCompat,
  IObservabilityCompat,
  IVectorStoreCompat,
  MCPServerConfig,
  ObservabilityProviderManifest,
  ProcessRouteManifest,
  ProviderManifest,
  RealtimeProviderManifest,
  UnifiedTool,
  VectorStoreConfig
} from '../../types.js';
import type { IRealtimeCompat } from '../../realtime-types.js';
import { ManifestError } from '../../errors.js';

import type { ManifestSourceMeta, PluginRegistryOptions } from './public-types.js';
import type { PluginRegistryState } from './state.js';
import { normalizeLookupConfig, getLookupAreaConfig, getManifestSource, getPackRootsLowToHigh } from './lookup.js';
import {
  ensureCompatModuleLoaded,
  ensureEmbeddingCompatLoaded,
  ensureObservabilityCompatLoaded,
  ensureRealtimeCompatLoaded,
  ensureVectorStoreCompatLoaded,
  resolvePluginCodeEntryMultiRoot
} from './code-modules.js';
import { validateAll } from './validate-all.js';

export class PluginRegistry {
  private state: PluginRegistryState;

  // NOTE: Keep internal tests working without exposing full state as public API.
  private get lookup() { return this.state.lookup; }
  private get providersLoaded() { return this.state.providersLoaded; }
  private get toolsLoaded() { return this.state.toolsLoaded; }
  private get mcpServersLoaded() { return this.state.mcpServersLoaded; }
  private get vectorStoresLoaded() { return this.state.vectorStoresLoaded; }
  private get processRoutesLoaded() { return this.state.processRoutesLoaded; }
  private get compatModulesLoaded() { return this.state.compatModulesLoaded; }
  private get compatModules() { return this.state.compatModules; }
  private get embeddingCompats() { return this.state.embeddingCompats; }
  private get vectorStoreCompats() { return this.state.vectorStoreCompats; }

  constructor(rootPath: string);
  constructor(options: PluginRegistryOptions);
  constructor(rootPathOrOptions: string | PluginRegistryOptions) {
    const baseState: PluginRegistryState = {
      rootPath: '',
      mode: 'legacy',
      lookup: null,
      manifestSources: new Map(),

      providers: new Map(),
      realtimeProviders: new Map(),
      tools: new Map(),
      mcpServers: new Map(),
      vectorStores: new Map(),
      processRoutes: [],

      compatModules: new Map(),
      embeddingProviders: new Map(),
      embeddingCompats: new Map(),
      vectorStoreCompats: new Map(),
      realtimeCompats: new Map(),
      observabilityProviders: new Map(),
      observabilityCompats: new Map(),

      providersLoaded: false,
      realtimeProvidersLoaded: false,
      toolsLoaded: false,
      mcpServersLoaded: false,
      vectorStoresLoaded: false,
      processRoutesLoaded: false,
      compatModulesLoaded: false,
      embeddingProvidersLoaded: false,
      embeddingCompatsLoaded: false,
      vectorStoreCompatsLoaded: false,
      realtimeCompatsLoaded: false,
      observabilityProvidersLoaded: false,
      observabilityCompatsLoaded: false
    };

    if (typeof rootPathOrOptions === 'string') {
      const resolvedRoot = path.isAbsolute(rootPathOrOptions)
        ? rootPathOrOptions
        : path.resolve(process.cwd(), rootPathOrOptions);

      if (!fs.existsSync(resolvedRoot)) {
        throw new ManifestError(`Plugin directory '${resolvedRoot}' does not exist`);
      }

      this.state = {
        ...baseState,
        mode: 'legacy',
        rootPath: resolvedRoot,
        lookup: null
      };

      return;
    }

    const cwd = process.cwd();
    const pluginsPath = (rootPathOrOptions.pluginsPath ?? './plugins').trim() || './plugins';
    const resolvedRoot = path.isAbsolute(pluginsPath) ? pluginsPath : path.resolve(cwd, pluginsPath);

    this.state = {
      ...baseState,
      mode: 'multi-root',
      rootPath: resolvedRoot,
      lookup: normalizeLookupConfig(cwd, rootPathOrOptions.lookup)
    };
  }

  async loadAll(): Promise<void> {
    // Deprecated: kept for backward compatibility but does nothing
    // All loading is now lazy and on-demand
  }

  getManifestSource(area: string, id: string): ManifestSourceMeta | undefined {
    return getManifestSource(this.state, area, id);
  }

  /**
   * Opt-in: validate and preload all manifests + referenced plugin code.
   * Useful for fail-fast startup checks in long-lived processes.
   *
   * Default usage remains lazy; callers must invoke this explicitly.
   */
  async validateAll(): Promise<void> {
    await validateAll(this.state);
  }

  // Exposed to unit tests via `(registry as any).getLookupAreaConfig` / `getPackRootsLowToHigh`.
  private getLookupAreaConfig(area: string) {
    return getLookupAreaConfig(this.state, area);
  }

  private getPackRootsLowToHigh(area: string, purpose: 'manifests' | 'code') {
    return getPackRootsLowToHigh(this.state, area, purpose);
  }

  // --- Internal loaders (lazy) ---

  private async loadProviders(): Promise<void> {
    const { loadProvidersInternal } = await import('./loaders/providers.js');
    return loadProvidersInternal(this.state);
  }

  private async loadRealtimeProviders(): Promise<void> {
    const { loadRealtimeProvidersInternal } = await import('./loaders/realtime-providers.js');
    return loadRealtimeProvidersInternal(this.state);
  }

  private async loadTools(): Promise<void> {
    const { loadToolsInternal } = await import('./loaders/tools.js');
    return loadToolsInternal(this.state);
  }

  private async loadMCPServers(): Promise<void> {
    const { loadMCPServersInternal } = await import('./loaders/mcp.js');
    return loadMCPServersInternal(this.state);
  }

  private async loadVectorStores(): Promise<void> {
    const { loadVectorStoresInternal } = await import('./loaders/vector.js');
    return loadVectorStoresInternal(this.state);
  }

  private async loadProcessRoutes(): Promise<void> {
    const { loadProcessRoutesInternal } = await import('./loaders/processes.js');
    return loadProcessRoutesInternal(this.state);
  }

  private async loadEmbeddingProviders(): Promise<void> {
    const { loadEmbeddingProvidersInternal } = await import('./loaders/embeddings.js');
    return loadEmbeddingProvidersInternal(this.state);
  }

  private async loadObservabilityProviders(): Promise<void> {
    const { loadObservabilityProvidersInternal } = await import('./loaders/observability-providers.js');
    return loadObservabilityProvidersInternal(this.state);
  }

  // --- Code-module loaders (lazy) ---

  private async ensureCompatModuleLoaded(moduleName: string, options?: { preferredPackRoot?: string }): Promise<string> {
    return ensureCompatModuleLoaded(this.state, moduleName, options);
  }

  private async ensureRealtimeCompatLoaded(kind: string, options?: { preferredPackRoot?: string }): Promise<string> {
    return ensureRealtimeCompatLoaded(this.state, kind, options);
  }

  private async ensureVectorStoreCompatLoaded(kind: string, options?: { preferredPackRoot?: string }): Promise<string> {
    return ensureVectorStoreCompatLoaded(this.state, kind, options);
  }

  private async ensureEmbeddingCompatLoaded(kind: string, options?: { preferredPackRoot?: string }): Promise<string> {
    return ensureEmbeddingCompatLoaded(this.state, kind, options);
  }

  private async ensureObservabilityCompatLoaded(kind: string, options?: { preferredPackRoot?: string }): Promise<string> {
    return ensureObservabilityCompatLoaded(this.state, kind, options);
  }

  // Exposed to unit tests via `(registry as any).resolvePluginCodeEntryMultiRoot`.
  private resolvePluginCodeEntryMultiRoot(
    area: 'compat' | 'embedding-compat' | 'vector-compat' | 'realtime-compat' | 'observability-compat',
    moduleName: string,
    preferredPackRoot?: string
  ): { modulePath: string; key: string } | undefined {
    return resolvePluginCodeEntryMultiRoot(this.state, area, moduleName, preferredPackRoot);
  }

  // --- Public getters ---

  async getProvider(id: string): Promise<ProviderManifest> {
    await this.loadProviders();
    const provider = this.state.providers.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown provider '${id}'`);
    }
    return provider;
  }

  async getCompatModuleForProvider(providerId: string): Promise<ICompatModule> {
    await this.loadProviders();
    const provider = this.state.providers.get(providerId);
    if (!provider) {
      throw new ManifestError(`Unknown provider '${providerId}'`);
    }

    const preferredPackRoot = getManifestSource(this.state, 'providers', providerId)?.root;
    const key = await this.ensureCompatModuleLoaded(provider.compat, { preferredPackRoot });
    return this.state.compatModules.get(key)!();
  }

  async getRealtimeProvider(id: string): Promise<RealtimeProviderManifest> {
    await this.loadRealtimeProviders();
    const provider = this.state.realtimeProviders.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown realtime provider '${id}'`);
    }
    return provider;
  }

  async getRealtimeCompatForProvider(providerId: string): Promise<IRealtimeCompat> {
    await this.loadRealtimeProviders();
    const provider = this.state.realtimeProviders.get(providerId);
    if (!provider) {
      throw new ManifestError(`Unknown realtime provider '${providerId}'`);
    }

    const preferredPackRoot = getManifestSource(this.state, 'realtime-providers', providerId)?.root;
    const key = await this.ensureRealtimeCompatLoaded(provider.compat, { preferredPackRoot });
    return this.state.realtimeCompats.get(key)!();
  }

  async getRealtimeCompat(kind: string): Promise<IRealtimeCompat> {
    const key = await this.ensureRealtimeCompatLoaded(kind);
    return this.state.realtimeCompats.get(key)!();
  }

  async getTool(name: string): Promise<UnifiedTool> {
    await this.loadTools();
    const tool = this.state.tools.get(name);
    if (!tool) {
      throw new ManifestError(`Unknown tool '${name}'`);
    }
    return tool;
  }

  async getTools(names: string[]): Promise<UnifiedTool[]> {
    await this.loadTools();
    return names.map(name => {
      const tool = this.state.tools.get(name);
      if (!tool) {
        throw new ManifestError(`Unknown tool '${name}'`);
      }
      return tool;
    });
  }

  async getMCPServer(id: string): Promise<MCPServerConfig> {
    await this.loadMCPServers();
    const server = this.state.mcpServers.get(id);
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
      const server = this.state.mcpServers.get(id);
      if (!server) {
        throw new ManifestError(`Unknown MCP server '${id}'`);
      }
      return server;
    });
  }

  async getVectorStore(id: string): Promise<VectorStoreConfig> {
    await this.loadVectorStores();
    const store = this.state.vectorStores.get(id);
    if (!store) {
      throw new ManifestError(`Unknown vector store '${id}'`);
    }
    return store;
  }

  async getVectorStoreCompatForStore(storeId: string): Promise<IVectorStoreCompat> {
    await this.loadVectorStores();
    const store = this.state.vectorStores.get(storeId);
    if (!store) {
      throw new ManifestError(`Unknown vector store '${storeId}'`);
    }

    const preferredPackRoot = getManifestSource(this.state, 'vector', storeId)?.root;
    const key = await this.ensureVectorStoreCompatLoaded(store.kind, { preferredPackRoot });
    return this.state.vectorStoreCompats.get(key)!();
  }

  async getVectorStoreCompat(kind: string): Promise<IVectorStoreCompat> {
    const key = await this.ensureVectorStoreCompatLoaded(kind);
    return this.state.vectorStoreCompats.get(key)!();
  }

  async getProcessRoutes(): Promise<ProcessRouteManifest[]> {
    await this.loadProcessRoutes();
    return this.state.processRoutes;
  }

  async getCompatModule(compat: string): Promise<ICompatModule> {
    const key = await this.ensureCompatModuleLoaded(compat);
    return this.state.compatModules.get(key)!();
  }

  async getEmbeddingProvider(id: string): Promise<EmbeddingProviderConfig> {
    await this.loadEmbeddingProviders();
    const config = this.state.embeddingProviders.get(id);
    if (!config) {
      throw new ManifestError(`Unknown embedding provider '${id}'`);
    }
    return config;
  }

  async getEmbeddingCompatForProvider(providerId: string): Promise<IEmbeddingCompat> {
    await this.loadEmbeddingProviders();
    const config = this.state.embeddingProviders.get(providerId);
    if (!config) {
      throw new ManifestError(`Unknown embedding provider '${providerId}'`);
    }

    const preferredPackRoot = getManifestSource(this.state, 'embeddings', providerId)?.root;
    const key = await this.ensureEmbeddingCompatLoaded(config.kind, { preferredPackRoot });
    return this.state.embeddingCompats.get(key)!();
  }

  async getEmbeddingCompat(kind: string): Promise<IEmbeddingCompat> {
    const key = await this.ensureEmbeddingCompatLoaded(kind);
    return this.state.embeddingCompats.get(key)!();
  }

  async getObservabilityProvider(id: string): Promise<ObservabilityProviderManifest> {
    await this.loadObservabilityProviders();
    const provider = this.state.observabilityProviders.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown observability provider '${id}'`);
    }
    return provider;
  }

  async getObservabilityCompatForProvider(providerId: string): Promise<IObservabilityCompat> {
    await this.loadObservabilityProviders();
    const provider = this.state.observabilityProviders.get(providerId);
    if (!provider) {
      throw new ManifestError(`Unknown observability provider '${providerId}'`);
    }

    const preferredPackRoot = getManifestSource(this.state, 'observability-providers', providerId)?.root;
    const key = await this.ensureObservabilityCompatLoaded(provider.compat, { preferredPackRoot });
    return this.state.observabilityCompats.get(key)!();
  }

  async getObservabilityCompat(compat: string): Promise<IObservabilityCompat> {
    const key = await this.ensureObservabilityCompatLoaded(compat);
    return this.state.observabilityCompats.get(key)!();
  }
}
