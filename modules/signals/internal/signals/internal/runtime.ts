import type { PluginRegistry } from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';

import { createBatchedHttpExporterRuntime } from '../../../../batched-http-exporter/index.js';

import type { SignalsTargetExporterConfig } from './config.js';
import { SignalsExporter } from './exporter.js';

const SIGNALS_RUNTIME_SYMBOL = Symbol.for('llm_adapter_signals_runtime');

const runtime = createBatchedHttpExporterRuntime<SignalsExporter>({
  runtimeSymbol: SIGNALS_RUNTIME_SYMBOL,
  getShutdownTimeoutMs: () => getDefaults().signals.shutdownTimeoutMs
});

export function ensureRuntimeHookInstalled(): void {
  runtime.ensureRuntimeHookInstalled(shutdownAllExporters);
}

export async function getOrCreateSharedExporter(
  registry: PluginRegistry,
  config: SignalsTargetExporterConfig
): Promise<SignalsExporter> {
  return await runtime.getOrCreateSharedExporter(registry, config, async () => {
    const manifest = await registry.getSignalsProvider(config.provider);
    const compat = typeof (registry as any).getSignalsCompatForProvider === 'function'
      ? await (registry as any).getSignalsCompatForProvider(manifest.id)
      : await registry.getSignalsCompat(manifest.compat);

    return new SignalsExporter(config, compat, manifest);
  });
}

export async function shutdownAllExporters(): Promise<void> {
  await runtime.shutdownAllExporters();
}
