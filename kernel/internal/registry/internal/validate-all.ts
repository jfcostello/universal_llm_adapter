import type { PluginRegistryState } from './state.js';

import { getManifestSource } from './lookup.js';
import {
  ensureCompatModuleLoaded,
  ensureEmbeddingCompatLoaded,
  ensureObservabilityCompatLoaded,
  ensureSignalsCompatLoaded,
  ensureRealtimeCompatLoaded,
  ensureVectorStoreCompatLoaded
} from './code-modules.js';

/**
 * Opt-in: validate and preload all manifests + referenced plugin code.
 * Useful for fail-fast startup checks in long-lived processes.
 *
 * Default usage remains lazy; callers must invoke this explicitly.
 */
export async function validateAll(state: PluginRegistryState): Promise<void> {
  const { loadProvidersInternal } = await import('./loaders/providers.js');
  const { loadRealtimeProvidersInternal } = await import('./loaders/realtime-providers.js');
  const { loadToolsInternal } = await import('./loaders/tools.js');
  const { loadMCPServersInternal } = await import('./loaders/mcp.js');
  const { loadVectorStoresInternal } = await import('./loaders/vector.js');
  const { loadProcessRoutesInternal } = await import('./loaders/processes.js');
  const { loadEmbeddingProvidersInternal } = await import('./loaders/embeddings.js');
  const { loadObservabilityProvidersInternal } = await import('./loaders/observability-providers.js');
  const { loadSignalsProvidersInternal } = await import('./loaders/signals-providers.js');

  await loadProvidersInternal(state, { strict: true });
  await loadRealtimeProvidersInternal(state, { strict: true });
  await loadToolsInternal(state, { strict: true });
  await loadMCPServersInternal(state, { strict: true });
  await loadVectorStoresInternal(state, { strict: true });
  await loadProcessRoutesInternal(state, { strict: true });
  await loadEmbeddingProvidersInternal(state, { strict: true });
  await loadObservabilityProvidersInternal(state, { strict: true });
  await loadSignalsProvidersInternal(state, { strict: true });

  // Validate that referenced plugin code modules exist and can be imported.
  for (const [id, provider] of state.providers.entries()) {
    const preferredPackRoot = getManifestSource(state, 'providers', id)?.root;
    await ensureCompatModuleLoaded(state, provider.compat, { preferredPackRoot });
  }

  for (const [id, provider] of state.realtimeProviders.entries()) {
    const preferredPackRoot = getManifestSource(state, 'realtime-providers', id)?.root;
    await ensureRealtimeCompatLoaded(state, provider.compat, { preferredPackRoot });
  }

  for (const [id, store] of state.vectorStores.entries()) {
    const preferredPackRoot = getManifestSource(state, 'vector', id)?.root;
    await ensureVectorStoreCompatLoaded(state, store.kind, { preferredPackRoot });
  }

  for (const [id, embedding] of state.embeddingProviders.entries()) {
    const preferredPackRoot = getManifestSource(state, 'embeddings', id)?.root;
    await ensureEmbeddingCompatLoaded(state, embedding.kind, { preferredPackRoot });
  }

  for (const [id, observability] of state.observabilityProviders.entries()) {
    const preferredPackRoot = getManifestSource(state, 'observability-providers', id)?.root;
    await ensureObservabilityCompatLoaded(state, observability.compat, { preferredPackRoot });
  }

  for (const [id, signals] of state.signalsProviders.entries()) {
    const preferredPackRoot = getManifestSource(state, 'signals-providers', id)?.root;
    await ensureSignalsCompatLoaded(state, signals.compat, { preferredPackRoot });
  }
}
