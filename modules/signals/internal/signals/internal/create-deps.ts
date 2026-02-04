import type { AdapterLogger, PluginRegistry, SignalsDeps, SignalsSpec } from '../../../../../kernel/index.js';
import { getDefaults, getNoopLogger, getNoopSignalsDeps } from '../../../../../kernel/index.js';

import { resolveConfig } from './config.js';
import { SignalsFanoutExporter } from './exporter.js';
import { ensureRuntimeHookInstalled, getOrCreateSharedExporter, shutdownAllExporters } from './runtime.js';

export async function createSignalsDeps(
  registry: PluginRegistry,
  spec?: SignalsSpec,
  logger: AdapterLogger = getNoopLogger()
): Promise<SignalsDeps> {
  const defaults = getDefaults().signals;
  const config = resolveConfig(spec, defaults, logger);

  if (!config) {
    return getNoopSignalsDeps();
  }

  ensureRuntimeHookInstalled();

  const exporters = [];
  for (const target of config.targets) {
    try {
      const exporter = await getOrCreateSharedExporter(registry, {
        provider: target.provider,
        providerConfig: target.providerConfig,
        logger: config.logger,
        flushAt: config.flushAt,
        flushIntervalMs: config.flushIntervalMs,
        maxQueueSize: config.maxQueueSize,
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
        timeoutMs: config.timeoutMs,
        maxAttributeValueBytes: config.maxAttributeValueBytes
      } as any);
      exporters.push(exporter);
    } catch (error: any) {
      logger.warning('Signals target failed to initialize', {
        provider: target.provider,
        error: (error as Error)?.message ?? String(error)
      });
    }
  }

  if (exporters.length === 0) {
    return getNoopSignalsDeps();
  }

  const exporter = new SignalsFanoutExporter(exporters as any);

  return {
    isEnabled: () => true,
    getExporter: () => exporter as any,
    shutdown: async () => {
      await shutdownAllExporters();
    }
  };
}
