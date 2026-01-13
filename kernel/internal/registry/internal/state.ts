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

import type { ManifestSourceMeta, PluginRegistryLookupAreaConfig } from './public-types.js';

export type PluginRegistryMode = 'legacy' | 'multi-root';

export interface NormalizedPluginRegistryLookupConfig {
  warnOnOverride: boolean;
  base: Required<Pick<PluginRegistryLookupAreaConfig, 'builtinManifests' | 'builtinCode' | 'local' | 'externalRoots'>>;
  areas: Record<string, PluginRegistryLookupAreaConfig>;
}

export interface PluginRegistryState {
  rootPath: string;
  mode: PluginRegistryMode;
  lookup: NormalizedPluginRegistryLookupConfig | null;
  manifestSources: Map<string, ManifestSourceMeta>;

  providers: Map<string, ProviderManifest>;
  realtimeProviders: Map<string, RealtimeProviderManifest>;
  tools: Map<string, UnifiedTool>;
  mcpServers: Map<string, MCPServerConfig>;
  vectorStores: Map<string, VectorStoreConfig>;
  processRoutes: ProcessRouteManifest[];

  compatModules: Map<string, () => ICompatModule>;
  embeddingProviders: Map<string, EmbeddingProviderConfig>;
  embeddingCompats: Map<string, () => IEmbeddingCompat>;
  vectorStoreCompats: Map<string, () => IVectorStoreCompat>;
  realtimeCompats: Map<string, () => IRealtimeCompat>;
  observabilityProviders: Map<string, ObservabilityProviderManifest>;
  observabilityCompats: Map<string, () => IObservabilityCompat>;

  // Lazy loading flags
  providersLoaded: boolean;
  realtimeProvidersLoaded: boolean;
  toolsLoaded: boolean;
  mcpServersLoaded: boolean;
  vectorStoresLoaded: boolean;
  processRoutesLoaded: boolean;
  compatModulesLoaded: boolean;
  embeddingProvidersLoaded: boolean;
  embeddingCompatsLoaded: boolean;
  vectorStoreCompatsLoaded: boolean;
  realtimeCompatsLoaded: boolean;
  observabilityProvidersLoaded: boolean;
  observabilityCompatsLoaded: boolean;
}

