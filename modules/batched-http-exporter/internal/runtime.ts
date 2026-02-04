import { createHash } from 'crypto';

import type { PluginRegistry } from '../../../kernel/index.js';

import { clampInt } from '../../shared/index.js';

import type { BatchedHttpExporter } from './exporter.js';
import type { BatchedHttpExporterConfig } from './types.js';

const DEFAULT_MAX_EXPORTERS_PER_REGISTRY = 10;

type RegistryRuntime<TExporter extends BatchedHttpExporter = BatchedHttpExporter> = {
  exportersByKey: Map<string, TExporter>;
  inflightByKey: Map<string, Promise<TExporter>>;
  maxExporters: number;
};

export function createBatchedHttpExporterRuntime<TExporter extends BatchedHttpExporter = BatchedHttpExporter>(options: {
  runtimeSymbol: symbol;
  getShutdownTimeoutMs: () => unknown;
}): {
  ensureRuntimeHookInstalled: (shutdownAll: () => Promise<void>) => void;
  getOrCreateSharedExporter: (
    registry: PluginRegistry,
    config: BatchedHttpExporterConfig,
    create: () => Promise<TExporter>
  ) => Promise<TExporter>;
  shutdownAllExporters: () => Promise<void>;
} {
  const runtimeByRegistry = new WeakMap<object, RegistryRuntime<TExporter>>();
  const runtimeRegistries = new Set<object>();
  let shutdownAllPromise: Promise<void> | null = null;

  function ensureRuntimeHookInstalled(shutdownAll: () => Promise<void>): void {
    const globalAny = globalThis as any;
    if (globalAny[options.runtimeSymbol]) return;
    globalAny[options.runtimeSymbol] = { shutdownAll };
  }

  function getOrCreateRegistryRuntime(registry: object): RegistryRuntime<TExporter> {
    const existing = runtimeByRegistry.get(registry);
    if (existing) {
      runtimeRegistries.add(registry);
      return existing;
    }

    const created: RegistryRuntime<TExporter> = {
      exportersByKey: new Map(),
      inflightByKey: new Map(),
      maxExporters: DEFAULT_MAX_EXPORTERS_PER_REGISTRY
    };

    runtimeByRegistry.set(registry, created);
    runtimeRegistries.add(registry);
    return created;
  }

  function stableSortForKey(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'symbol') return String(value);
    if (typeof value === 'function') return '[function]';

    const obj = value as object;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);

    if (Array.isArray(value)) {
      return value.map(entry => stableSortForKey(entry, seen));
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = stableSortForKey(record[key], seen);
    }
    return out;
  }

  function stableStringifyForKey(value: unknown): string {
    try {
      return JSON.stringify(stableSortForKey(value, new WeakSet()));
    } catch {
      return JSON.stringify(String(value));
    }
  }

  function hashKey(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  function buildExporterCacheKey(config: BatchedHttpExporterConfig): string {
    const providerConfigHash =
      config.providerConfig === null || config.providerConfig === undefined
        ? 'no_provider_config'
        : hashKey(stableStringifyForKey(config.providerConfig));
    return [
      String(config.provider),
      String(config.flushAt),
      String(config.flushIntervalMs),
      String(config.maxQueueSize),
      String(config.maxAttempts),
      String(config.baseDelayMs),
      String(config.maxDelayMs),
      String(config.timeoutMs),
      String(config.maxAttributeValueBytes),
      providerConfigHash
    ].join('|');
  }

  function enforceExporterCacheBound(runtime: RegistryRuntime<TExporter>): void {
    while (runtime.exportersByKey.size > runtime.maxExporters) {
      const oldestKey = runtime.exportersByKey.keys().next().value as string;

      const exporter = runtime.exportersByKey.get(oldestKey);
      runtime.exportersByKey.delete(oldestKey);

      void exporter?.shutdown().catch(() => {});
    }
  }

  async function getOrCreateSharedExporter(
    registry: PluginRegistry,
    config: BatchedHttpExporterConfig,
    create: () => Promise<TExporter>
  ): Promise<TExporter> {
    const runtime = getOrCreateRegistryRuntime(registry as unknown as object);
    const key = buildExporterCacheKey(config);

    const cached = runtime.exportersByKey.get(key);
    if (cached) {
      runtime.exportersByKey.delete(key);
      runtime.exportersByKey.set(key, cached);
      return cached;
    }

    const inflight = runtime.inflightByKey.get(key);
    if (inflight) return inflight;

    const createPromise = (async () => {
      const exporter = await create();
      runtime.exportersByKey.set(key, exporter);
      runtime.inflightByKey.delete(key);
      enforceExporterCacheBound(runtime);
      return exporter;
    })();

    runtime.inflightByKey.set(key, createPromise);

    try {
      return await createPromise;
    } finally {
      runtime.inflightByKey.delete(key);
    }
  }

  async function shutdownAllExporters(): Promise<void> {
    if (shutdownAllPromise) return shutdownAllPromise;

    shutdownAllPromise = (async () => {
      const shutdownTimeoutMs = clampInt(options.getShutdownTimeoutMs(), 5000, 0, 300_000);

      const exporters: TExporter[] = [];
      for (const registry of runtimeRegistries) {
        const runtime = runtimeByRegistry.get(registry)!;
        for (const exporter of runtime.exportersByKey.values()) {
          exporters.push(exporter);
        }
        runtime.exportersByKey.clear();
        runtime.inflightByKey.clear();
      }

      if (shutdownTimeoutMs <= 0) {
        for (const exporter of exporters) {
          exporter.setShutdownSignal?.(undefined);
        }
        await Promise.all(exporters.map(exp => Promise.resolve().then(() => exp.shutdown()).catch(() => {})));
        runtimeRegistries.clear();
        return;
      }

      const abortController = new AbortController();
      for (const exporter of exporters) {
        exporter.setShutdownSignal?.(abortController.signal);
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        timeoutId = setTimeout(() => {
          for (const exporter of exporters) {
            exporter.logShutdownSummary?.({ timedOut: true, shutdownTimeoutMs });
          }
          try {
            abortController.abort();
          } catch {
            // ignore
          }
          resolve('timeout');
        }, shutdownTimeoutMs);
        (timeoutId as any)?.unref?.();
      });

      const shutdownPromise = Promise.all(
        exporters.map(exp => Promise.resolve().then(() => exp.shutdown()).catch(() => {}))
      ).then(() => 'ok' as const);

      try {
        await Promise.race([shutdownPromise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      runtimeRegistries.clear();
    })().finally(() => {
      shutdownAllPromise = null;
    });

    return shutdownAllPromise;
  }

  return { ensureRuntimeHookInstalled, getOrCreateSharedExporter, shutdownAllExporters };
}
