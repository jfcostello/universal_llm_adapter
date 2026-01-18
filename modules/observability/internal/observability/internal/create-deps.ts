import type { AdapterLogger, ObservabilityDeps, ObservabilitySpec, PluginRegistry } from '../../../../../kernel/index.js';
import { getDefaults, getNoopLogger, getNoopObservabilityDeps } from '../../../../../kernel/index.js';

import { resolveConfig } from './config.js';
import { ensureRuntimeHookInstalled, getOrCreateSharedExporter, shutdownAllExporters } from './runtime.js';

/**
 * Create observability deps for a given configuration.
 *
 * @param registry - Plugin registry for loading providers/compats
 * @param spec - Optional per-call observability spec
 * @returns ObservabilityDeps (noop if disabled)
 */
export async function createObservabilityDeps(
  registry: PluginRegistry,
  spec?: ObservabilitySpec,
  logger: AdapterLogger = getNoopLogger()
): Promise<ObservabilityDeps> {
  const defaults = getDefaults().observability;
  const config = resolveConfig(spec, defaults, logger);

  if (!config) {
    return getNoopObservabilityDeps();
  }

  try {
    ensureRuntimeHookInstalled();

    const exporter = await getOrCreateSharedExporter(registry, config);

    return {
      isEnabled: () => true,
      getExporter: () => exporter,
      shutdown: async () => {
        await shutdownAllExporters();
      }
    };
  } catch (error: any) {
    logger.warning('Observability failed to initialize', {
      provider: config.provider,
      error: (error as Error)?.message ?? String(error)
    });
    return getNoopObservabilityDeps();
  }
}
