import type { PluginRegistry } from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';

import { createBatchedHttpExporterRuntime } from '../../../../batched-http-exporter/index.js';

import type { ObservabilityExporterConfig } from './config.js';
import { ObservabilityExporter } from './exporter.js';

const OBSERVABILITY_RUNTIME_SYMBOL = Symbol.for('llm_adapter_observability_runtime');

const runtime = createBatchedHttpExporterRuntime<ObservabilityExporter>({
  runtimeSymbol: OBSERVABILITY_RUNTIME_SYMBOL,
  getShutdownTimeoutMs: () => getDefaults().observability.shutdownTimeoutMs
});

export function ensureRuntimeHookInstalled(): void {
  runtime.ensureRuntimeHookInstalled(shutdownAllExporters);
}

export async function getOrCreateSharedExporter(
  registry: PluginRegistry,
  config: ObservabilityExporterConfig
): Promise<ObservabilityExporter> {
  return await runtime.getOrCreateSharedExporter(registry, config, async () => {
    const manifest = await registry.getObservabilityProvider(config.provider);
    const compat = typeof (registry as any).getObservabilityCompatForProvider === 'function'
      ? await (registry as any).getObservabilityCompatForProvider(manifest.id)
      : await registry.getObservabilityCompat(manifest.compat);

    return new ObservabilityExporter(config, compat, manifest);
  });
}

export async function shutdownAllExporters(): Promise<void> {
  await runtime.shutdownAllExporters();
}
