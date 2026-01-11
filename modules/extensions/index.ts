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
