import type { PluginRegistryState } from './state.js';

type ManifestLoadedFlagKey = keyof Pick<
  PluginRegistryState,
  | 'providersLoaded'
  | 'realtimeProvidersLoaded'
  | 'toolsLoaded'
  | 'mcpServersLoaded'
  | 'vectorStoresLoaded'
  | 'processRoutesLoaded'
  | 'embeddingProvidersLoaded'
  | 'observabilityProvidersLoaded'
>;

const inflightByState = new WeakMap<PluginRegistryState, Map<string, Promise<void>>>();

function getInflightMap(state: PluginRegistryState): Map<string, Promise<void>> {
  const existing = inflightByState.get(state);
  if (existing) return existing;
  const created = new Map<string, Promise<void>>();
  inflightByState.set(state, created);
  return created;
}

export function runLoaderOnce(
  state: PluginRegistryState,
  loadedFlag: ManifestLoadedFlagKey,
  loaderKey: string,
  load: () => Promise<void>
): Promise<void> {
  if (state[loadedFlag]) {
    return Promise.resolve();
  }

  const inflight = getInflightMap(state);
  const existing = inflight.get(loaderKey);
  if (existing) return existing;

  const promise = (async () => {
    await load();
    state[loadedFlag] = true;
  })();

  const wrapped = promise.finally(() => {
    inflight.delete(loaderKey);
  });

  inflight.set(loaderKey, wrapped);
  return wrapped;
}

const inflightCodeModulesByState = new WeakMap<PluginRegistryState, Map<string, Promise<string>>>();

function getInflightCodeModuleMap(state: PluginRegistryState): Map<string, Promise<string>> {
  const existing = inflightCodeModulesByState.get(state);
  if (existing) return existing;
  const created = new Map<string, Promise<string>>();
  inflightCodeModulesByState.set(state, created);
  return created;
}

/**
 * Deduplicates concurrent code module imports.
 * If the key is already in the provided stateMap, returns immediately.
 * If an import is already in progress for the key, returns the existing promise.
 * Otherwise, runs the load function and adds the result to the stateMap.
 */
export function runCodeModuleLoadOnce<T>(
  state: PluginRegistryState,
  stateMap: Map<string, T>,
  key: string,
  load: () => Promise<T>
): Promise<string> {
  if (stateMap.has(key)) {
    return Promise.resolve(key);
  }

  const inflight = getInflightCodeModuleMap(state);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const result = await load();
    stateMap.set(key, result);
    return key;
  })();

  const wrapped = promise.finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, wrapped);
  return wrapped;
}

