import type { PluginRegistryState } from './state.js';

export function createBasePluginRegistryState(): PluginRegistryState {
  return {
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
    signalsProviders: new Map(),
    signalsCompats: new Map(),
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
    observabilityCompatsLoaded: false,
    signalsProvidersLoaded: false,
    signalsCompatsLoaded: false
  };
}

