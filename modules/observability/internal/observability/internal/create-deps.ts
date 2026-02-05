import type { AdapterLogger, ObservabilityDeps, ObservabilitySpec, PluginRegistry } from '../../../../../kernel/index.js';
import { getDefaults, getNoopLogger, getNoopObservabilityDeps } from '../../../../../kernel/index.js';

import { resolveTargets } from './config.js';
import { ensureRuntimeHookInstalled, getOrCreateSharedExporter, shutdownAllExporters } from './runtime.js';
import { MultiObservabilityExporter } from './multi-exporter.js';

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
  const targets = resolveTargets(spec, defaults, logger);

  if (!targets || targets.length === 0) {
    return getNoopObservabilityDeps();
  }

  try {
    ensureRuntimeHookInstalled();

    const targetExporters = await Promise.all(
      targets.map(async target => {
        const exporter = await getOrCreateSharedExporter(registry, target.config);
        return { provider: target.provider, exporter, export: target.export };
      })
    );

    const exporter = targetExporters.length === 1
      ? targetExporters[0].exporter
      : new MultiObservabilityExporter(targetExporters);

    return {
      isEnabled: () => true,
      getExporter: () => exporter,
      shutdown: async () => {
        await shutdownAllExporters();
      }
    };
  } catch (error: any) {
    logger.warning('Observability failed to initialize', {
      ...(targets.length === 1 ? { provider: targets[0]?.provider } : {}),
      providers: targets.map(t => t.provider),
      error: (error as Error)?.message ?? String(error)
    });
    return getNoopObservabilityDeps();
  }
}
