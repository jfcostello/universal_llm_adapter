export type {
  ExtensionSourceKind,
  ResolvedExtensionEntry
} from './internal/extension-lookup.js';

export {
  listExtensions,
  mergeExtensionConfig,
  loadExtensionDefaults,
  resolveExtensionEntry
} from './internal/extension-lookup.js';

export type {
  GetExtensionPluginRootsOptions
} from './internal/extension-paths.js';

export {
  getExtensionPluginRoots,
  resetExtensionPluginRootsCache
} from './internal/extension-paths.js';
