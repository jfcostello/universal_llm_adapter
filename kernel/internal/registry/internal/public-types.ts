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

export interface ManifestSourceMeta {
  kind: PluginRegistrySourceKind;
  root: string;
  filePath: string;
  precedence: number;
}

