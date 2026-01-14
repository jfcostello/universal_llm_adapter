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
  ExtensionPaths,
  GetExtensionPathsOptions
} from './internal/extension-paths.js';

export {
  getExtensionPaths,
  resetExtensionPathsCache
} from './internal/extension-paths.js';
