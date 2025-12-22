/**
 * Package root entrypoint (switchboard).
 *
 * This file must remain extremely lean:
 * - No static re-exports of feature modules.
 * - Public API is call-based wrappers that `import()` modules on-demand.
 * - First-use imports are promise-cached to be concurrency-safe.
 *
 * Subpath exports (e.g. `llm-adapter/server`) remain available for direct access
 * and backwards compatibility.
 */

import type { RequestListener } from 'node:http';

export type { ServerOptions, RunningServer } from './modules/server/index.js';
export type { UnifiedCliDependencies } from './modules/cli/index.js';
export type { DefaultSettings } from './modules/kernel/index.js';
export type {
  CoordinatorLifecycleDeps,
  PluginRegistryLike,
  FactoryPluginRegistryLike,
  LLMCoordinatorLike,
  VectorCoordinatorLike,
  EmbeddingCoordinatorLike
} from './modules/lifecycle/index.js';
export type { RealtimeSession } from './modules/realtime/index.js';

let kernelPromise: Promise<typeof import('./modules/kernel/index.js')> | null = null;
const loadKernel = () => (kernelPromise ??= import('./modules/kernel/index.js'));

let cliPromise: Promise<typeof import('./modules/cli/index.js')> | null = null;
const loadCli = () => (cliPromise ??= import('./modules/cli/index.js'));

let serverPromise: Promise<typeof import('./modules/server/index.js')> | null = null;
const loadServer = () => (serverPromise ??= import('./modules/server/index.js'));

let lifecyclePromise: Promise<typeof import('./modules/lifecycle/index.js')> | null = null;
const loadLifecycle = () => (lifecyclePromise ??= import('./modules/lifecycle/index.js'));

let realtimePromise: Promise<typeof import('./modules/realtime/index.js')> | null = null;
const loadRealtime = () => (realtimePromise ??= import('./modules/realtime/index.js'));

// ==================== CLI ====================

export async function runUnifiedCli(argv?: string[]): Promise<void> {
  const { runUnifiedCli: run } = await loadCli();
  return run(argv);
}

// ==================== Defaults ====================

export async function getDefaults(): Promise<import('./modules/kernel/index.js').DefaultSettings> {
  const { getDefaults } = await loadKernel();
  return getDefaults();
}

// ==================== Server ====================

export async function createServer(options: import('./modules/server/index.js').ServerOptions = {}): Promise<import('./modules/server/index.js').RunningServer> {
  const { createServer } = await loadServer();
  return createServer(options);
}

export async function createServerHandlerWithDefaults(
  options: import('./modules/server/index.js').ServerOptions = {}
): Promise<RequestListener> {
  const { createServerHandlerWithDefaults } = await loadServer();
  return createServerHandlerWithDefaults(options);
}

// ==================== Lifecycle ====================

export async function createRegistry(pluginsPath: string): Promise<import('./modules/lifecycle/index.js').FactoryPluginRegistryLike> {
  const { createRegistry } = await loadLifecycle();
  return createRegistry(pluginsPath);
}

export async function createLlmCoordinator(
  registry: import('./modules/lifecycle/index.js').FactoryPluginRegistryLike
): Promise<import('./modules/lifecycle/index.js').LLMCoordinatorLike> {
  const { createLlmCoordinator } = await loadLifecycle();
  return createLlmCoordinator(registry);
}

export async function createVectorCoordinator(
  registry: import('./modules/lifecycle/index.js').FactoryPluginRegistryLike
): Promise<import('./modules/lifecycle/index.js').VectorCoordinatorLike> {
  const { createVectorCoordinator } = await loadLifecycle();
  return createVectorCoordinator(registry);
}

export async function createEmbeddingCoordinator(
  registry: import('./modules/lifecycle/index.js').FactoryPluginRegistryLike
): Promise<import('./modules/lifecycle/index.js').EmbeddingCoordinatorLike> {
  const { createEmbeddingCoordinator } = await loadLifecycle();
  return createEmbeddingCoordinator(registry);
}

export async function closeLogger(): Promise<void> {
  const { closeLogger } = await loadLifecycle();
  return closeLogger();
}

export const runWithCoordinatorLifecycle: typeof import('./modules/lifecycle/index.js').runWithCoordinatorLifecycle = async (
  options
) => {
  const { runWithCoordinatorLifecycle: run } = await loadLifecycle();
  return run(options);
};

export const streamWithCoordinatorLifecycle: typeof import('./modules/lifecycle/index.js').streamWithCoordinatorLifecycle = async function* (
  options
) {
  const { streamWithCoordinatorLifecycle: stream } = await loadLifecycle();
  yield* stream(options);
};

// ==================== Realtime ====================

export async function createRealtimeSession(
  registry: Parameters<typeof import('./modules/realtime/index.js').createRealtimeSession>[0],
  spec: Parameters<typeof import('./modules/realtime/index.js').createRealtimeSession>[1]
): Promise<import('./modules/realtime/index.js').RealtimeSession> {
  const { createRealtimeSession } = await loadRealtime();
  return createRealtimeSession(registry, spec);
}

export async function createWsTransport(
  options: Parameters<typeof import('./modules/realtime/index.js').createWsTransport>[0]
): Promise<ReturnType<typeof import('./modules/realtime/index.js').createWsTransport>> {
  const { createWsTransport } = await loadRealtime();
  return createWsTransport(options);
}
