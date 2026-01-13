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

